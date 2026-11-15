"""Shared fixtures for the retrieval tests (search, ask, compare, lab).

The tests do not go through upload and ingestion: collections, documents, pages and chunks are
inserted straight into the schema, and the API is exercised through a small FastAPI app that mounts
only the retrieval routers with ``current_user`` overridden. Embeddings come from deterministic
test embedders, so nothing is downloaded.

Test modules load the fixtures with ``pytest_plugins = ["retrieval_helpers"]`` and import the plain
helpers directly. PYTEST_DONT_REWRITE (the module is imported before pytest could rewrite it, and its
only assertion is the status check in ``Workspace.ok``).
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import Engine, insert, update

from passageport.answer import llm
from passageport.api.deps import current_user
from passageport.api.ratelimit import reset_rate_limits
from passageport.api.routes import ask, compare, lab, search
from passageport.config import Settings, get_settings
from passageport.db.engine import create_db_engine
from passageport.db.schema import chunks, collections, documents, pages, users, utcnow
from passageport.domain import User
from passageport.errors import ApiError
from passageport.ml import registry
from passageport.ml.hashing import HashingEmbedder
from passageport.ml.protocols import to_blob
from passageport.search import index as index_module

ALICE = User(id="user-alice", username="alice")
BOB = User(id="user-bob", username="bob")


class ConceptEmbedder:
    """A hand-checkable stand-in for a semantic model.

    Every word belongs to at most one named concept; a text's vector counts its concepts. Two texts
    are similar exactly when they talk about the same concepts, whatever words they use.
    """

    backend = "test"
    model = "concepts"
    CONCEPTS: tuple[tuple[str, ...], ...] = (
        ("car", "cars", "automobile", "vehicle", "vehicles"),
        ("repair", "repairs", "fix", "fixing", "service", "serviced", "maintenance"),
        ("password", "passphrase", "credential", "credentials", "login"),
        ("recover", "recovery", "reset", "restore", "forgot", "forgotten", "lost"),
        ("network", "connection", "connections", "socket", "sockets"),
        ("error", "errors", "failure", "failures", "fault"),
        ("cook", "cooking", "recipe", "simmer", "bake", "sauce", "bread"),
        ("rate", "limit", "limits", "requests", "throttle", "quota"),
        ("authentication", "authenticated", "key", "keys", "token"),
        ("sandbox", "testing", "playground"),
    )

    def __init__(self) -> None:
        self.dimensions = len(self.CONCEPTS) + 1
        self.version = f"test:concepts:{self.dimensions}"
        self._concept_of = {word: i for i, words in enumerate(self.CONCEPTS) for word in words}

    def _embed(self, text: str) -> np.ndarray:
        vector = np.zeros(self.dimensions, dtype=np.float32)
        for word in re.findall(r"[a-z]+", text.lower()):
            concept = self._concept_of.get(word)
            if concept is not None:
                vector[concept] += 1.0
        if not vector.any():
            vector[-1] = 1.0  # "about nothing we know": similar only to other such texts
        return vector / np.linalg.norm(vector)

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        return (
            np.stack([self._embed(t) for t in texts]) if texts else np.zeros((0, self.dimensions), np.float32)
        )

    def embed_query(self, text: str) -> np.ndarray:
        return self._embed(text)

    def count_tokens(self, text: str) -> int:
        return len(text.split())


class FakeReranker:
    """Scores a passage by a caller-supplied function of (query, passage)."""

    backend = "test"
    model = "fake-reranker"

    def __init__(self, scorer: Callable[[str, str], float]) -> None:
        self._scorer = scorer
        self.calls: list[tuple[str, list[str]]] = []

    def score(self, query: str, passages: list[str]) -> list[float]:
        self.calls.append((query, list(passages)))
        return [float(self._scorer(query, p)) for p in passages]


class FakeLLM:
    """An ``LLMClient`` that returns a canned reply (or raises) and records what it was sent."""

    model = "fake-llm"

    def __init__(self, reply: str | Exception) -> None:
        self.reply = reply
        self.calls: list[list[dict[str, str]]] = []

    def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls.append(messages)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def build_app(engine: Engine, settings: Settings, acting: list[User]) -> FastAPI:
    """The retrieval routers alone, with the same error envelope as the real application."""
    app = FastAPI()
    app.state.engine = engine
    app.state.settings = settings

    def _error(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return _error(exc.status_code, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        return _error(422, "invalid_request", f"{where}: {first.get('msg', 'invalid request')}")

    for module in (search, ask, compare, lab):
        app.include_router(module.router)
    app.dependency_overrides[current_user] = lambda: acting[0]
    return app


@dataclass
class Workspace:
    engine: Engine
    settings: Settings
    client: TestClient
    embedder: Any
    monkeypatch: pytest.MonkeyPatch
    _acting: list[User] = field(default_factory=lambda: [ALICE])
    _counter: int = 0

    # ----------------------------------------------------------------- acting user / models

    def act_as(self, user: User) -> None:
        self._acting[0] = user

    def use_reranker(self, reranker: Any) -> None:
        self.monkeypatch.setattr(registry, "get_reranker", lambda: reranker)

    def use_llm(self, reply: str | Exception) -> FakeLLM:
        fake = FakeLLM(reply)
        self.monkeypatch.setattr(llm, "get_client", lambda _settings: fake)
        return fake

    # ----------------------------------------------------------------- data

    def _next(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}-{self._counter:03d}"

    def collection(self, name: str = "Handbook", owner: User = ALICE) -> str:
        collection_id = self._next("col")
        now = utcnow()
        with self.engine.begin() as conn:
            conn.execute(
                insert(collections),
                [
                    {
                        "id": collection_id,
                        "owner_id": owner.id,
                        "name": f"{name} {collection_id}",
                        "description": "",
                        "index_version": 0,
                        "created_at": now,
                        "updated_at": now,
                    }
                ],
            )
        return collection_id

    def bump(self, collection_id: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                update(collections)
                .where(collections.c.id == collection_id)
                .values(index_version=collections.c.index_version + 1)
            )

    def document(
        self,
        collection_id: str,
        title: str,
        sections: list[str],
        *,
        owner: User = ALICE,
        kind: str = "md",
        status: str = "indexed",
        embedding_version: str | None = None,
    ) -> str:
        """Insert a document whose pages are ``sections`` and whose chunks are their paragraphs.

        ``status`` other than ``indexed`` stores the document without pages or chunks.
        ``embedding_version`` labels the chunks as embedded by another model (a stale document).
        """
        document_id = self._next("doc")
        now = utcnow()
        version = embedding_version or self.embedder.version
        page_rows = []
        chunk_rows = []
        if status == "indexed":
            for number, text in enumerate(sections, start=1):
                page_rows.append(
                    {
                        "document_id": document_id,
                        "page_number": number,
                        "label": f"Section {number}",
                        "text": text,
                    }
                )
                for match in re.finditer(r"\S(?:.*\S)?", text):  # one chunk per non-empty line
                    chunk_rows.append(
                        {
                            "id": hashlib.sha256(
                                f"{document_id}|{number}|{match.start()}|{match.end()}".encode()
                            ).hexdigest()[:24],
                            "document_id": document_id,
                            "collection_id": collection_id,
                            "ordinal": len(chunk_rows),
                            "page_number": number,
                            "char_start": match.start(),
                            "char_end": match.end(),
                            "text": match.group(),
                            "token_count": self.embedder.count_tokens(match.group()),
                            "embedding": to_blob(self.embedder.embed_documents([match.group()])[0]),
                            "embedding_version": version,
                        }
                    )
        with self.engine.begin() as conn:
            conn.execute(
                insert(documents),
                [
                    {
                        "id": document_id,
                        "collection_id": collection_id,
                        "owner_id": owner.id,
                        "title": title,
                        "filename": f"{document_id}.{kind}",
                        "kind": kind,
                        "size_bytes": sum(len(s) for s in sections),
                        "sha256": hashlib.sha256(document_id.encode()).hexdigest(),
                        "blob_key": document_id,
                        "status": status,
                        "page_count": len(page_rows),
                        "chunk_count": len(chunk_rows),
                        "token_count": sum(r["token_count"] for r in chunk_rows),
                        "embedding_version": version if status == "indexed" else None,
                        "chunker_version": "test-lines" if status == "indexed" else None,
                        "created_at": now,
                        "updated_at": now,
                        "indexed_at": now if status == "indexed" else None,
                    }
                ],
            )
            if page_rows:
                conn.execute(insert(pages), page_rows)
            if chunk_rows:
                conn.execute(insert(chunks), chunk_rows)
            conn.execute(
                update(collections)
                .where(collections.c.id == collection_id)
                .values(index_version=collections.c.index_version + 1)
            )
        return document_id

    # ----------------------------------------------------------------- HTTP

    def post(self, path: str, payload: dict[str, Any]) -> httpx.Response:
        return self.client.post(path, json=payload)

    def ok(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self.post(path, payload)
        assert response.status_code == 200, response.text
        return response.json()


@pytest.fixture
def make_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Workspace]]:
    """Factory: ``make_workspace(embedder=..., **settings)`` -> a fresh database and API client."""
    engines: list[Engine] = []

    def factory(embedder: Any | None = None, **overrides: Any) -> Workspace:
        values: dict[str, Any] = {
            "data_dir": tmp_path / f"data{len(engines)}",
            "embedding_backend": "hashing",
            "reranker_backend": "none",
            "rate_limit_per_minute": 0,
            # The hashing embedder scores unrelated texts near 0 and texts sharing words well above.
            "min_vector_similarity": 0.3,
            "log_level": "WARNING",
        }
        values.update(overrides)
        for key, value in values.items():
            monkeypatch.setenv(f"PP_{key.upper()}", str(value))
        monkeypatch.setitem(Settings.model_config, "env_file", None)
        get_settings.cache_clear()
        settings = get_settings()
        chosen = embedder or HashingEmbedder()
        monkeypatch.setattr(registry, "get_embedder", lambda: chosen)
        monkeypatch.setattr(registry, "get_reranker", lambda: None)
        index_module.clear_cache()
        reset_rate_limits()

        engine = create_db_engine(settings)
        engines.append(engine)
        now = utcnow()
        with engine.begin() as conn:
            conn.execute(
                insert(users),
                [
                    {"id": user.id, "username": user.username, "is_guest": False, "created_at": now}
                    for user in (ALICE, BOB)
                ],
            )
        acting = [ALICE]
        client = TestClient(build_app(engine, settings, acting))
        return Workspace(engine, settings, client, chosen, monkeypatch, acting)

    yield factory
    for engine in engines:
        engine.dispose()
    index_module.clear_cache()
    get_settings.cache_clear()


@pytest.fixture
def workspace(make_workspace: Callable[..., Workspace]) -> Workspace:
    return make_workspace()


# A small corpus used by several test modules. One line = one chunk.
NETWORK_SECTIONS = [
    "The error ECONNRESET means the peer closed the connection abruptly.\n"
    "Set max_chunk_tokens to 256 before indexing long manuals.",
    "To recover a lost password, open the account page and request a reset link by email.\n"
    "The reset link expires after 30 minutes.",
]
KITCHEN_SECTIONS = [
    "Simmer the tomato sauce for twenty minutes and add fresh basil at the end.\n"
    "Knead the bread dough until it is smooth and elastic.",
]
OUT_OF_SCOPE_QUERY = "quantum chromodynamics lattice gauge theory"


def handbook(workspace: Workspace) -> tuple[str, str, str]:
    """(collection id, network document id, kitchen document id) owned by Alice."""
    collection_id = workspace.collection()
    network = workspace.document(collection_id, "Network handbook", NETWORK_SECTIONS)
    kitchen = workspace.document(collection_id, "Kitchen notes", KITCHEN_SECTIONS, kind="txt")
    return collection_id, network, kitchen
