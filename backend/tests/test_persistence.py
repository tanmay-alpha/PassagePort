"""Durability: restarts, blob stores and the orphan sweep."""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from conftest import CSRF_HEADERS, SAMPLE_PAGES, build_pdf, create_collection, upload_file
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select, update

from passageport.auth import service
from passageport.db import repos
from passageport.db.schema import blobs, chunks, documents, users, utcnow
from passageport.ingest.worker import run_pending_jobs
from passageport.storage.blobs import (
    BlobNotFoundError,
    DbBlobStore,
    FsBlobStore,
    get_blob_store,
    new_blob_key,
    sweep_orphan_blobs,
)


def _files(root) -> list:
    return sorted(p for p in root.rglob("*") if p.is_file())


def test_documents_survive_an_application_restart(make_settings, make_app):
    settings = make_settings()
    pdf = build_pdf(SAMPLE_PAGES)
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        collection = create_collection(client, "Durable")
        document = upload_file(client, collection, "biology.pdf", pdf).json()["document"]
        run_pending_jobs(client.app.state.engine, settings)
        before = client.get(f"/api/documents/{document['id']}").json()
        page_before = client.get(f"/api/documents/{document['id']}/pages/2").json()
        with client.app.state.engine.connect() as conn:
            chunk_ids = sorted(conn.execute(select(chunks.c.id)).scalars())
        assert before["status"] == "indexed"

    # A brand-new application object on the same data directory: nothing lives in process memory.
    with TestClient(make_app(make_settings()), headers=CSRF_HEADERS) as client:
        assert [c["name"] for c in client.get("/api/collections").json()] == ["Durable"]
        listing = client.get(f"/api/collections/{collection}/documents").json()
        assert listing == [before]
        assert client.get(f"/api/documents/{document['id']}/pages/2").json() == page_before
        assert len(client.get(f"/api/documents/{document['id']}/outline").json()["items"]) == 3
        assert client.get(f"/api/documents/{document['id']}/file").content == pdf
        for chunk_id in chunk_ids:
            assert client.get(f"/api/chunks/{chunk_id}").status_code == 200
        assert client.get("/api/system").json()["usage"]["documents"] == 1


def test_queued_job_survives_a_restart(make_settings, make_app):
    settings = make_settings()
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        collection = create_collection(client)
        document = upload_file(client, collection, "notes.txt", b"indexed after the restart").json()[
            "document"
        ]

    restarted = make_settings()
    with TestClient(make_app(restarted), headers=CSRF_HEADERS) as client:
        assert client.get(f"/api/documents/{document['id']}").json()["status"] == "uploaded"
        assert client.get("/api/system").json()["pending_jobs"] == 1
        assert run_pending_jobs(client.app.state.engine, restarted) == 1
        assert client.get(f"/api/documents/{document['id']}").json()["status"] == "indexed"


def test_database_blob_backend_round_trip(make_settings, make_app):
    settings = make_settings(blob_backend="db")
    pdf = build_pdf(["Stored in the database."])
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        engine = client.app.state.engine
        assert client.get("/api/system").json()["blob_backend"] == "db"
        collection = create_collection(client)
        document = upload_file(client, collection, "in-db.pdf", pdf).json()["document"]
        assert upload_file(client, collection, "copy.pdf", pdf).json()["duplicate"] is True
        run_pending_jobs(engine, settings)

        assert client.get(f"/api/documents/{document['id']}").json()["status"] == "indexed"
        assert client.get(f"/api/documents/{document['id']}/file").content == pdf
        with engine.connect() as conn:
            assert conn.execute(select(func.count()).select_from(blobs)).scalar_one() == 1
        assert _files(settings.data_dir / "blobs") == []  # nothing on disk

        assert client.delete(f"/api/documents/{document['id']}").status_code == 204
        with engine.connect() as conn:
            assert conn.execute(select(func.count()).select_from(blobs)).scalar_one() == 0


@pytest.fixture(params=["fs", "db"])
def store(request, make_settings, make_app):
    settings = make_settings(blob_backend=request.param)
    engine = make_app(settings).state.engine
    blob_store = get_blob_store(settings, engine)
    assert isinstance(blob_store, FsBlobStore if request.param == "fs" else DbBlobStore)
    return blob_store


def test_blob_store_contract(store):
    key = new_blob_key()
    assert not store.exists(key)
    with pytest.raises(BlobNotFoundError):
        store.get(key)

    payload = os.urandom(70_000)
    store.put(key, payload)
    assert store.exists(key)
    assert store.get(key) == payload

    store.put(key, b"replaced")  # overwrite is atomic and complete
    assert store.get(key) == b"replaced"

    store.delete(key)
    store.delete(key)  # idempotent
    assert not store.exists(key)


def test_blob_removal_is_split_around_the_commit(store):
    """Whichever backend: after ``remove_in_transaction`` + commit + ``remove_files`` the blob is
    gone, and a rolled-back transaction leaves it in place."""
    engine = store.engine if isinstance(store, DbBlobStore) else None
    kept, removed = new_blob_key(), new_blob_key()
    store.put(kept, b"kept")
    store.put(removed, b"removed")
    if engine is None:
        store.remove_files([removed])
    else:
        with pytest.raises(RuntimeError), engine.begin() as conn:
            store.remove_in_transaction(conn, [kept])
            raise RuntimeError("rolled back")
        with engine.begin() as conn:
            store.remove_in_transaction(conn, [removed])
        store.remove_files([removed])
    assert store.exists(kept)
    assert not store.exists(removed)


@pytest.mark.parametrize(
    "key",
    [
        "",
        "short",
        "../../etc/passwd",
        "..\\evil",
        "A" * 32,
        "g" * 32,
        "a" * 31,
        "a" * 33,
        "aa/" + "a" * 29,
        "a" * 32 + "\n",
    ],
)
def test_blob_stores_only_accept_server_generated_keys(store, key):
    for operation in (
        lambda: store.put(key, b"x"),
        lambda: store.get(key),
        lambda: store.delete(key),
        lambda: store.exists(key),
    ):
        with pytest.raises(ValueError):
            operation()


def test_fs_put_leaves_no_temp_files(tmp_path):
    store = FsBlobStore(tmp_path / "blobs")
    keys = [new_blob_key() for _ in range(5)]
    for key in keys:
        store.put(key, key.encode())
    files = _files(tmp_path / "blobs")
    assert sorted(f.name for f in files) == sorted(keys)
    assert all(f.parent.name == f.name[:2] for f in files)


def test_orphan_sweep_removes_only_old_unreferenced_files(client, collection_id, engine, settings):
    upload_file(client, collection_id, "kept.txt", b"referenced by a document")
    store = get_blob_store(settings, engine)
    blob_dir = settings.data_dir / "blobs"
    (live,) = _files(blob_dir)

    old_orphan, young_orphan = new_blob_key(), new_blob_key()
    store.put(old_orphan, b"left behind by a crash")
    store.put(young_orphan, b"an upload that is being committed right now")
    stale_temp = blob_dir / "ab" / f"{new_blob_key()}.1234abcd.tmp"
    stale_temp.parent.mkdir(exist_ok=True)
    stale_temp.write_bytes(b"partial write")
    long_ago = time.time() - 7200
    for path in (live, blob_dir / old_orphan[:2] / old_orphan, stale_temp):
        os.utime(path, (long_ago, long_ago))

    assert sweep_orphan_blobs(engine, settings) == 2

    assert live.exists()  # referenced, however old
    assert store.exists(young_orphan)  # too recent to be judged
    assert not store.exists(old_orphan)
    assert not stale_temp.exists()
    assert sweep_orphan_blobs(engine, settings, min_age_seconds=0) == 1
    assert not store.exists(young_orphan)
    assert _files(blob_dir) == [live]


def test_startup_sweeps_orphan_blobs(make_settings, make_app):
    settings = make_settings()
    store = FsBlobStore(settings.data_dir / "blobs")
    orphan = new_blob_key()
    store.put(orphan, b"orphan")
    long_ago = time.time() - 7200
    os.utime(settings.data_dir / "blobs" / orphan[:2] / orphan, (long_ago, long_ago))

    with TestClient(make_app(settings), headers=CSRF_HEADERS):
        assert not store.exists(orphan)


def test_sqlite_database_lives_in_the_data_directory(client, settings):
    if settings.database_url:
        pytest.skip("running against an external database")
    assert (settings.data_dir / "passageport.db").is_file()
    assert client.get("/api/system").json()["database"] == "sqlite"


def _count(engine, table) -> int:
    with engine.connect() as conn:
        return conn.execute(select(func.count()).select_from(table)).scalar_one()


def test_db_blob_shares_the_document_transaction(make_settings, make_app, monkeypatch):
    """With the database backend a blob must never be committed without its document row: if the
    insert of the document fails, the uploaded bytes are rolled back with it."""
    settings = make_settings(blob_backend="db")
    app = make_app(settings)
    engine = app.state.engine
    with TestClient(app, headers=CSRF_HEADERS, raise_server_exceptions=False) as client:
        collection = create_collection(client)

        def fail_after_blob(*_args, **_kwargs):
            assert _blob_rows_visible_to_others(engine) == 0  # written, but not committed
            raise RuntimeError("database went away")

        monkeypatch.setattr(repos, "insert_document", fail_after_blob)
        response = upload_file(client, collection, "lost.txt", b"confidential bytes")

        assert response.status_code == 500
        assert _count(engine, blobs) == 0
        assert _count(engine, documents) == 0


def _blob_rows_visible_to_others(engine) -> int:
    """Blob rows as another connection sees them. SQLite readers are not blocked in WAL mode."""
    return _count(engine, blobs)


def test_db_orphan_blobs_are_swept(make_settings, make_app):
    settings = make_settings(blob_backend="db")
    app = make_app(settings)
    engine = app.state.engine
    store = get_blob_store(settings, engine)
    with TestClient(app, headers=CSRF_HEADERS) as client:
        collection = create_collection(client)
        upload_file(client, collection, "kept.txt", b"referenced")
    orphan = new_blob_key()
    store.put(orphan, b"left behind by an older version or a manual change")
    assert _count(engine, blobs) == 2

    assert sweep_orphan_blobs(engine, settings) == 1

    assert not store.exists(orphan)
    assert _count(engine, blobs) == 1
    assert sweep_orphan_blobs(engine, settings) == 0

    # And it runs at startup for this backend too.
    store.put(orphan, b"again")
    with TestClient(make_app(settings), headers=CSRF_HEADERS):
        assert not store.exists(orphan)
        assert _count(engine, blobs) == 1


@pytest.mark.parametrize("target", ["documents", "collections"])
def test_db_blob_and_owner_deletion_roll_back_together(make_settings, make_app, monkeypatch, target):
    settings = make_settings(blob_backend="db")
    app = make_app(settings)
    engine = app.state.engine
    with TestClient(app, headers=CSRF_HEADERS, raise_server_exceptions=False) as client:
        collection = create_collection(client)
        document = upload_file(client, collection, "kept.txt", b"must survive rollback").json()["document"]
        remove = DbBlobStore.remove_in_transaction

        def fail_after_deleting_blob(self, conn, keys):
            remove(self, conn, keys)
            raise RuntimeError("transaction aborted")

        monkeypatch.setattr(DbBlobStore, "remove_in_transaction", fail_after_deleting_blob)
        identifier = document["id"] if target == "documents" else collection
        response = client.delete(f"/api/{target}/{identifier}")

        assert response.status_code == 500
        assert _count(engine, documents) == 1
        assert _count(engine, blobs) == 1
        assert client.get(f"/api/documents/{document['id']}/file").content == b"must survive rollback"


def test_db_orphan_sweep_does_not_delete_an_upload_in_flight(make_settings, make_app, monkeypatch):
    settings = make_settings(blob_backend="db")
    app = make_app(settings)
    engine = app.state.engine
    insert_document = repos.insert_document
    sweep_started = threading.Event()
    sweeps = []

    def observe_sweep(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.startswith("DELETE FROM blobs"):
            sweep_started.set()

    with ThreadPoolExecutor(max_workers=1) as pool:

        def sweep_before_document_insert(conn, **values):
            sweep_started.clear()
            sweeps.append(pool.submit(sweep_orphan_blobs, engine, settings))
            assert sweep_started.wait(10)
            assert _count(engine, blobs) == 0
            return insert_document(conn, **values)

        monkeypatch.setattr(repos, "insert_document", sweep_before_document_insert)
        event.listen(engine, "before_cursor_execute", observe_sweep)
        try:
            with TestClient(app, headers=CSRF_HEADERS) as client:
                collection = create_collection(client)
                uploaded = upload_file(client, collection, "kept.txt", b"transactional original")
                assert uploaded.status_code == 201
                assert sweeps[0].result(timeout=20) == 0
                document = uploaded.json()["document"]
                downloaded = client.get(f"/api/documents/{document['id']}/file")
                assert downloaded.content == b"transactional original"
                assert _count(engine, blobs) == _count(engine, documents) == 1
        finally:
            event.remove(engine, "before_cursor_execute", observe_sweep)


@pytest.mark.parametrize("target", ["collection", "guest"])
def test_deleting_an_owner_waits_for_its_inflight_upload(make_accounts, monkeypatch, target):
    """Deletion must collect blob keys only after all earlier uploads of that owner commit."""
    accounts = make_accounts(blob_backend="db", allow_guests=True, guest_ttl_hours=1)
    engine = accounts.app.state.engine
    client = accounts.client() if target == "guest" else accounts.signup("alice")
    if target == "guest":
        guest_id = client.post("/api/auth/guest").json()["user"]["id"]
    collection = create_collection(client)
    if target == "guest":
        with engine.begin() as conn:
            conn.execute(
                update(users).where(users.c.id == guest_id).values(created_at=utcnow() - timedelta(hours=2))
            )

    blob_written = threading.Event()
    allow_commit = threading.Event()
    deleting = threading.Event()
    owner_lock_requested = threading.Event()
    put = DbBlobStore.put

    def hold_upload(self, key, data, conn=None):
        put(self, key, data, conn)
        blob_written.set()
        assert allow_commit.wait(10)

    def observe_lock(_conn, _cursor, statement, _parameters, _context, _many):
        if (
            deleting.is_set()
            and "users" in statement
            and ("FOR UPDATE" in statement or statement.startswith("UPDATE users"))
        ):
            owner_lock_requested.set()

    def remove_owner():
        deleting.set()
        if target == "guest":
            return service.purge_expired_guests(engine, accounts.settings)
        return client.delete(f"/api/collections/{collection}").status_code

    monkeypatch.setattr(DbBlobStore, "put", hold_upload)
    event.listen(engine, "before_cursor_execute", observe_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            uploading = pool.submit(
                upload_file, client, collection, "racing.txt", b"never orphan these bytes"
            )
            assert blob_written.wait(10)
            deletion = pool.submit(remove_owner)
            try:
                assert owner_lock_requested.wait(10)
            finally:
                allow_commit.set()
            assert uploading.result(timeout=20).status_code == 201
            assert deletion.result(timeout=20) == (1 if target == "guest" else 204)
    finally:
        allow_commit.set()
        event.remove(engine, "before_cursor_execute", observe_lock)
    assert _count(engine, documents) == _count(engine, blobs) == 0
