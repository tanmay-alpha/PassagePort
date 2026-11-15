"""Shared fixtures.

Every test runs against a fresh data directory with the deterministic hashing embedder and
``job_mode=manual`` (indexing happens when a test calls ``index_all()``). Set
``PP_TEST_DATABASE_URL`` to run the same tests against PostgreSQL instead of SQLite.
"""

from __future__ import annotations

import importlib
import io
import json
import os
import textwrap
import threading
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import docx
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema
from sqlalchemy.sql import text as sql_text

import passageport.app as app_module
from passageport.api.ratelimit import reset_rate_limits
from passageport.auth.throttle import reset_throttles
from passageport.config import Settings, get_settings
from passageport.ingest.worker import run_pending_jobs, stop_worker
from passageport.ml.registry import reset_models

CSRF_HEADERS = {"X-PassagePort-CSRF": "1"}
PASSWORD = "correct horse battery"
TEST_DATABASE_URL = os.environ.get("PP_TEST_DATABASE_URL", "")

# Routers owned by this half of the backend; the app is useless to these tests without them.
_REQUIRED_ROUTERS = {
    "passageport.api.routes.system",
    "passageport.api.routes.auth",
    "passageport.api.routes.collections",
    "passageport.api.routes.documents",
}


def _env_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple, dict)):
        return json.dumps(value)
    return str(value)


def _importable_routers() -> tuple[str, ...]:
    """The routers of ``create_app`` that can be imported right now.

    The retrieval routers (search/ask/compare/lab) are developed separately; if one of them is
    missing or does not import, the app is still built by the real factory, just without it.
    """
    available = []
    for name in app_module.ROUTERS:
        try:
            importlib.import_module(name)
        except ImportError:
            if name in _REQUIRED_ROUTERS:
                raise
            continue
        available.append(name)
    return tuple(available)


@pytest.fixture(autouse=True)
def _clean_process_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Settings, models, throttles and the worker are process-wide: reset them around each test."""
    for name in list(os.environ):
        if name.startswith("PP_") and name != "PP_TEST_DATABASE_URL":
            monkeypatch.delenv(name)
    # Never pick up a developer's backend/.env.
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    monkeypatch.setattr(app_module, "ROUTERS", _importable_routers())
    get_settings.cache_clear()
    yield
    stop_worker()
    get_settings.cache_clear()
    reset_models()
    reset_throttles()
    reset_rate_limits()


@pytest.fixture
def isolated_database_url() -> Iterator[str]:
    """Use a fresh PostgreSQL schema, never drop tables in the supplied database's public schema."""
    if not TEST_DATABASE_URL:
        yield ""
        return
    url = make_url(Settings(database_url=TEST_DATABASE_URL).resolved_database_url)
    if url.get_backend_name() != "postgresql":
        raise ValueError("PP_TEST_DATABASE_URL must point to a disposable PostgreSQL database")
    schema = f"pp_test_{uuid.uuid4().hex}"
    admin = create_engine(url)
    scoped_url = url.update_query_dict({"options": f"-csearch_path={schema}"})
    probe = create_engine(scoped_url)
    with admin.begin() as conn:
        conn.execute(CreateSchema(schema))
    try:
        with probe.connect() as conn:
            assert conn.dialect.name == "postgresql"
            assert conn.execute(sql_text("SELECT current_schema()")).scalar_one() == schema
        yield scoped_url.render_as_string(hide_password=False)
    finally:
        probe.dispose()
        with admin.begin() as conn:
            conn.execute(DropSchema(schema, cascade=True))
        admin.dispose()


@pytest.fixture
def make_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, isolated_database_url: str
) -> Callable[..., Settings]:
    """Factory for the process-wide settings.

    Settings are applied through ``PP_*`` environment variables so that ``get_settings()`` - used
    by the model registry and by ``Depends(get_settings)`` - returns exactly the object the app
    was built with. Calling the factory again replaces the settings but keeps the data directory
    (and database), which is how the restart tests work.
    """

    def factory(**overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "data_dir": tmp_path / "data",
            "embedding_backend": "hashing",
            "reranker_backend": "none",
            "job_mode": "manual",
            "cookie_secure": False,
            "log_level": "WARNING",
        }
        if isolated_database_url:
            values["database_url"] = isolated_database_url
        values.update(overrides)
        for key, value in values.items():
            monkeypatch.setenv(f"PP_{key.upper()}", _env_value(value))
        get_settings.cache_clear()
        reset_models()
        return get_settings()

    return factory


@pytest.fixture
def settings(make_settings: Callable[..., Settings]) -> Settings:
    return make_settings()


@pytest.fixture
def make_app() -> Iterator[Callable[[Settings], FastAPI]]:
    """Build apps with the real factory and dispose their engines afterwards."""
    apps: list[FastAPI] = []

    def factory(settings: Settings) -> FastAPI:
        app = app_module.create_app(settings)
        app.dependency_overrides[get_settings] = lambda: settings
        apps.append(app)
        return app

    yield factory
    for app in apps:
        app.state.engine.dispose()


@pytest.fixture
def app(settings: Settings, make_app: Callable[[Settings], FastAPI]) -> FastAPI:
    return make_app(settings)


@pytest.fixture
def engine(app: FastAPI) -> Engine:
    return app.state.engine


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """Local-mode client that sends the CSRF header, with the app's lifespan running."""
    with TestClient(app, headers=CSRF_HEADERS) as test_client:
        yield test_client


@pytest.fixture
def index_all(app: FastAPI) -> Callable[[], int]:
    """Run every queued indexing job synchronously; returns how many ran."""

    def run() -> int:
        return run_pending_jobs(app.state.engine, get_settings())

    return run


# --------------------------------------------------------------------------- accounts mode


@dataclass
class Accounts:
    """An accounts-mode app plus helpers to create independent signed-in clients."""

    app: FastAPI
    settings: Settings

    def client(self) -> TestClient:
        """A fresh client with its own cookie jar (not signed in)."""
        return TestClient(self.app, headers=CSRF_HEADERS)

    def signup(self, username: str, password: str = PASSWORD) -> TestClient:
        client = self.client()
        response = client.post("/api/auth/signup", json={"username": username, "password": password})
        assert response.status_code == 200, response.text
        return client

    def index_all(self) -> int:
        return run_pending_jobs(self.app.state.engine, get_settings())


@pytest.fixture
def make_accounts(
    make_settings: Callable[..., Settings], make_app: Callable[[Settings], FastAPI]
) -> Callable[..., Accounts]:
    def factory(**overrides: Any) -> Accounts:
        settings = make_settings(auth_mode="accounts", **overrides)
        return Accounts(app=make_app(settings), settings=settings)

    return factory


@pytest.fixture
def accounts(make_accounts: Callable[..., Accounts]) -> Accounts:
    return make_accounts()


# --------------------------------------------------------------------------- document builders


def build_pdf(pages: list[str], *, encrypt: str | None = None) -> bytes:
    """A real PDF with one page per entry. An empty string gives a page without any text."""
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter, encrypt=encrypt, invariant=1)
    for text in pages:
        cursor = pdf.beginText(72, 720)
        cursor.setFont("Helvetica", 11)
        for paragraph in text.split("\n"):
            for line in textwrap.wrap(paragraph, 85) or [""]:
                cursor.textLine(line)
        pdf.drawText(cursor)
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def build_docx(blocks: list[tuple[str, str]], table: list[list[str]] | None = None) -> bytes:
    """A DOCX from ("h1" | "h2" | "p", text) blocks, optionally followed by a table."""
    document = docx.Document()
    for kind, text in blocks:
        if kind == "p":
            document.add_paragraph(text)
        else:
            document.add_heading(text, level=int(kind[1]))
    if table:
        grid = document.add_table(rows=len(table), cols=len(table[0]))
        for row_index, row in enumerate(table):
            for column_index, value in enumerate(row):
                grid.cell(row_index, column_index).text = value
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def make_pdf() -> Callable[..., bytes]:
    return build_pdf


@pytest.fixture
def make_docx() -> Callable[..., bytes]:
    return build_docx


def upload_file(client: TestClient, collection_id: str, name: str, data: bytes) -> httpx.Response:
    return client.post(
        f"/api/collections/{collection_id}/documents",
        files={"file": (name, data, "application/octet-stream")},
    )


def create_collection(client: TestClient, name: str = "Research") -> str:
    response = client.post("/api/collections", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def burst(count: int, call: Callable[[int], Any]) -> list[Any]:
    """Run ``call(i)`` in ``count`` threads released at the same instant; results in order."""
    barrier = threading.Barrier(count)
    results: list[Any] = [None] * count

    def run(index: int) -> None:
        barrier.wait(timeout=30)
        try:
            results[index] = call(index)
        except Exception as exc:  # returned, so the test can assert on it
            results[index] = exc

    threads = [threading.Thread(target=run, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)
    return results


@pytest.fixture
def upload() -> Callable[..., httpx.Response]:
    return upload_file


@pytest.fixture
def collection_id(client: TestClient) -> str:
    return create_collection(client)


SAMPLE_PAGES = [
    "Photosynthesis converts light energy into chemical energy. Chlorophyll absorbs red and blue light.",
    "The Calvin cycle fixes carbon dioxide into sugars. It takes place in the stroma of the chloroplast.",
    "Cellular respiration releases the stored energy. Mitochondria produce most of the ATP in a cell.",
]


@pytest.fixture
def indexed_pdf(client: TestClient, collection_id: str, index_all: Callable[[], int]) -> dict[str, Any]:
    """An uploaded and indexed three-page PDF, as returned by the API."""
    response = upload_file(client, collection_id, "biology.pdf", build_pdf(SAMPLE_PAGES))
    assert response.status_code == 201, response.text
    index_all()
    document = client.get(f"/api/documents/{response.json()['document']['id']}").json()
    assert document["status"] == "indexed", document
    return document
