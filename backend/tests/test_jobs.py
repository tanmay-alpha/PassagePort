"""The indexing queue: failure semantics, re-indexing, leases, retries and the worker thread."""

from __future__ import annotations

import threading
import time
from datetime import timedelta

import pytest
from conftest import CSRF_HEADERS, SAMPLE_PAGES, build_pdf, create_collection, upload_file
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from passageport import parsing
from passageport.db.schema import chunks, collections, documents, jobs, pages, utcnow
from passageport.ingest import pipeline, worker
from passageport.ingest.pipeline import GENERIC_FAILURE
from passageport.ingest.worker import claim_next, enqueue, interrupted_message, process_job, run_pending_jobs
from passageport.parsing import ParseError
from passageport.storage.blobs import get_blob_store


def _job(engine, document_id: str):
    with engine.connect() as conn:
        return conn.execute(
            select(jobs).where(jobs.c.document_id == document_id).order_by(jobs.c.created_at.desc())
        ).first()


def _chunk_ids(engine, document_id: str) -> list[str]:
    with engine.connect() as conn:
        return list(
            conn.execute(
                select(chunks.c.id).where(chunks.c.document_id == document_id).order_by(chunks.c.ordinal)
            ).scalars()
        )


def _index_version(engine) -> int:
    with engine.connect() as conn:
        return conn.execute(select(collections.c.index_version)).scalar_one()


def _document(client, document_id: str) -> dict:
    return client.get(f"/api/documents/{document_id}").json()


# --------------------------------------------------------------------------- outcomes


def test_successful_job_is_recorded(client, engine, indexed_pdf):
    job = _job(engine, indexed_pdf["id"])
    assert job.status == "succeeded"
    assert job.attempts == 1
    assert job.error is None
    assert job.lease_expires_at is None
    assert job.started_at is not None and job.finished_at is not None
    assert _index_version(engine) == 1


def test_first_time_failure_marks_the_document_failed_and_keeps_the_file(
    client, collection_id, index_all, engine, settings
):
    scanned = build_pdf(["", ""])
    document = upload_file(client, collection_id, "scan.pdf", scanned).json()["document"]
    assert index_all() == 1

    failed = _document(client, document["id"])
    assert failed["status"] == "failed"
    assert "scanned" in failed["error"] and "OCR is not supported" in failed["error"]
    assert failed["chunk_count"] == 0 and failed["page_count"] == 0 and failed["indexed_at"] is None
    assert failed["stale"] is False
    assert client.get(f"/api/documents/{document['id']}/file").content == scanned

    job = _job(engine, document["id"])
    assert (job.status, job.attempts) == ("failed", 1)  # deterministic failures are not retried
    assert job.error == failed["error"]
    assert index_all() == 0
    assert _index_version(engine) == 0


@pytest.mark.parametrize(
    ("name", "data", "fragment"),
    [
        ("locked.pdf", build_pdf(["secret"], encrypt="pw"), "password-protected"),
        ("broken.pdf", b"%PDF-1.7 not a real document", "could not be read as a PDF"),
        ("blank.txt", b"   \n\n  ", "no text"),
    ],
)
def test_parse_failures_surface_a_user_safe_message(client, collection_id, index_all, name, data, fragment):
    document = upload_file(client, collection_id, name, data).json()["document"]
    index_all()
    failed = _document(client, document["id"])
    assert failed["status"] == "failed"
    assert fragment in failed["error"]


def test_parse_timeout_fails_the_document(make_settings, make_app):
    settings = make_settings(parse_timeout_seconds=0)
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        collection = create_collection(client)
        document = upload_file(client, collection, "slow.txt", b"text").json()["document"]
        run_pending_jobs(client.app.state.engine, settings)
        failed = _document(client, document["id"])
        assert failed["status"] == "failed"
        assert "took too long" in failed["error"]


def test_reindex_of_a_failed_document_can_succeed(client, collection_id, index_all, engine, monkeypatch):
    def refuse(*_args, **_kwargs):
        raise ParseError("Temporarily unreadable.")

    document = upload_file(client, collection_id, "notes.txt", b"perfectly fine text").json()["document"]
    with monkeypatch.context() as patch:
        patch.setattr(parsing, "parse_document", refuse)
        index_all()
    assert _document(client, document["id"])["status"] == "failed"

    accepted = client.post(f"/api/documents/{document['id']}/reindex")
    assert accepted.status_code == 202
    assert accepted.json()["status"] == "processing"
    assert accepted.json()["error"] is None
    assert index_all() == 1

    indexed = _document(client, document["id"])
    assert indexed["status"] == "indexed" and indexed["error"] is None and indexed["chunk_count"] == 1


# --------------------------------------------------------------------------- re-index


def test_reindex_keeps_chunk_ids_stable_and_bumps_index_version(client, engine, index_all, indexed_pdf):
    before = _chunk_ids(engine, indexed_pdf["id"])
    version = _index_version(engine)

    response = client.post(f"/api/documents/{indexed_pdf['id']}/reindex")
    assert response.status_code == 202
    assert response.json()["status"] == "processing"
    # The previous index keeps serving until the new one is committed.
    assert _chunk_ids(engine, indexed_pdf["id"]) == before
    assert client.get(f"/api/chunks/{before[0]}").status_code == 200
    assert index_all() == 1

    assert _chunk_ids(engine, indexed_pdf["id"]) == before
    assert _index_version(engine) == version + 1
    after = _document(client, indexed_pdf["id"])
    assert after["status"] == "indexed"
    assert after["indexed_at"] > indexed_pdf["indexed_at"]
    assert after["chunk_count"] == len(before)


def test_reindex_conflicts_while_indexing_is_pending(client, collection_id, index_all, engine):
    document = upload_file(client, collection_id, "notes.txt", b"some text").json()["document"]

    uploaded = client.post(f"/api/documents/{document['id']}/reindex")
    assert uploaded.status_code == 409
    assert uploaded.json()["error"]["code"] == "conflict"

    index_all()
    assert client.post(f"/api/documents/{document['id']}/reindex").status_code == 202
    processing = client.post(f"/api/documents/{document['id']}/reindex")
    assert processing.status_code == 409
    with engine.connect() as conn:
        active = conn.execute(select(jobs).where(jobs.c.status == "queued")).all()
    assert len(active) == 1
    assert client.post("/api/documents/missing/reindex").status_code == 404


def test_failed_reindex_keeps_the_previous_index(client, engine, index_all, indexed_pdf, monkeypatch):
    before = _chunk_ids(engine, indexed_pdf["id"])
    version = _index_version(engine)

    def refuse(*_args, **_kwargs):
        raise ParseError("The file could not be read this time.")

    client.post(f"/api/documents/{indexed_pdf['id']}/reindex")
    with monkeypatch.context() as patch:
        patch.setattr(parsing, "parse_document", refuse)
        assert index_all() == 1

    document = _document(client, indexed_pdf["id"])
    assert document["status"] == "indexed"
    assert document["error"] == "Last re-index failed: The file could not be read this time."
    assert document["chunk_count"] == len(before)
    assert document["indexed_at"] == indexed_pdf["indexed_at"]
    assert _chunk_ids(engine, indexed_pdf["id"]) == before
    assert _index_version(engine) == version  # nothing changed, so caches stay valid
    assert client.get(f"/api/documents/{indexed_pdf['id']}/pages/1").status_code == 200
    assert _job(engine, indexed_pdf["id"]).status == "failed"

    # A later successful run clears the message.
    client.post(f"/api/documents/{indexed_pdf['id']}/reindex")
    index_all()
    assert _document(client, indexed_pdf["id"])["error"] is None


def test_unexpected_errors_are_retried_then_reported_generically(
    client, collection_id, index_all, engine, monkeypatch, caplog
):
    calls = 0

    def explode(texts):
        nonlocal calls
        calls += 1
        raise RuntimeError("secret document text: " + texts[0])

    monkeypatch.setattr(pipeline.get_embedder(), "embed_documents", explode, raising=False)
    document = upload_file(client, collection_id, "notes.txt", b"confidential quarterly numbers").json()[
        "document"
    ]
    with caplog.at_level("INFO", logger="passageport"):
        assert index_all() == 2  # job_max_attempts

    assert calls == 2
    failed = _document(client, document["id"])
    assert failed["status"] == "failed"
    assert failed["error"] == GENERIC_FAILURE
    job = _job(engine, document["id"])
    assert (job.status, job.attempts, job.error) == ("failed", 2, GENERIC_FAILURE)
    # The exception type is logged; its message (which quotes the document) is not.
    assert "RuntimeError" in caplog.text
    assert "confidential" not in caplog.text and "secret document text" not in caplog.text


def test_missing_blob_fails_with_a_clear_message(client, collection_id, index_all, engine, settings):
    document = upload_file(client, collection_id, "notes.txt", b"some text").json()["document"]
    with engine.connect() as conn:
        key = conn.execute(select(documents.c.blob_key)).scalar_one()
    get_blob_store(settings, engine).delete(key)
    index_all()
    failed = _document(client, document["id"])
    assert failed["status"] == "failed"
    assert failed["error"] == "The original file is no longer available. Upload it again."


def test_document_deleted_while_indexing_is_not_resurrected(
    client, collection_id, engine, settings, monkeypatch
):
    document = upload_file(client, collection_id, "notes.txt", b"some text to index").json()["document"]
    real_prepare = pipeline.prepare_index

    def delete_then_prepare(*args, **kwargs):
        prepared = real_prepare(*args, **kwargs)
        assert client.delete(f"/api/documents/{document['id']}").status_code == 204
        return prepared

    monkeypatch.setattr(pipeline, "prepare_index", delete_then_prepare)
    assert run_pending_jobs(engine, settings) == 1

    with engine.connect() as conn:
        assert conn.execute(select(documents)).all() == []
        assert conn.execute(select(chunks)).all() == []
        assert conn.execute(select(pages)).all() == []
        assert conn.execute(select(jobs)).all() == []


# --------------------------------------------------------------------------- leases


def _crash_while_running(engine, settings, *, attempts: int = 1, expired: bool = True) -> None:
    """Leave the queue the way a killed worker would: a ``running`` job nobody is renewing."""
    job = claim_next(engine, settings)
    assert job is not None
    lease = utcnow() + timedelta(seconds=-5 if expired else 300)
    with engine.begin() as conn:
        conn.execute(
            update(jobs).where(jobs.c.id == job.id).values(lease_expires_at=lease, attempts=attempts)
        )
        conn.execute(update(documents).values(status="processing"))


def test_claim_is_exclusive_and_sets_a_lease(client, collection_id, engine, settings):
    upload_file(client, collection_id, "notes.txt", b"some text")
    before = utcnow()
    job = claim_next(engine, settings)
    assert job is not None and job.attempts == 1
    assert claim_next(engine, settings) is None  # running with a live lease: not claimable

    row = _job(engine, job.document_id)
    assert row.status == "running"
    assert row.lease_expires_at >= before + timedelta(seconds=settings.job_lease_seconds - 1)


def test_expired_lease_is_recovered_by_the_next_worker(client, collection_id, engine, settings):
    document = upload_file(client, collection_id, "notes.txt", b"text that survives a crash").json()[
        "document"
    ]
    _crash_while_running(engine, settings)
    assert _document(client, document["id"])["status"] == "processing"

    assert run_pending_jobs(engine, settings) == 1

    assert _document(client, document["id"])["status"] == "indexed"
    job = _job(engine, document["id"])
    assert (job.status, job.attempts) == ("succeeded", 2)


def test_live_lease_is_not_stolen(client, collection_id, engine, settings):
    document = upload_file(client, collection_id, "notes.txt", b"text").json()["document"]
    _crash_while_running(engine, settings, expired=False)
    assert run_pending_jobs(engine, settings) == 0
    assert _document(client, document["id"])["status"] == "processing"


def test_job_is_abandoned_after_max_attempts(client, collection_id, engine, settings):
    document = upload_file(client, collection_id, "notes.txt", b"text").json()["document"]
    _crash_while_running(engine, settings, attempts=settings.job_max_attempts)

    assert run_pending_jobs(engine, settings) == 0

    failed = _document(client, document["id"])
    assert failed["status"] == "failed"
    assert failed["error"] == interrupted_message(settings.job_max_attempts)
    assert "interrupted 2 times" in failed["error"]
    assert _job(engine, document["id"]).status == "failed"
    # The user can still retry by hand.
    assert client.post(f"/api/documents/{document['id']}/reindex").status_code == 202
    assert run_pending_jobs(engine, settings) == 1
    assert _document(client, document["id"])["status"] == "indexed"


def test_abandoned_reindex_keeps_the_previous_index(client, engine, settings, indexed_pdf):
    before = _chunk_ids(engine, indexed_pdf["id"])
    client.post(f"/api/documents/{indexed_pdf['id']}/reindex")
    _crash_while_running(engine, settings, attempts=settings.job_max_attempts)
    run_pending_jobs(engine, settings)

    document = _document(client, indexed_pdf["id"])
    assert document["status"] == "indexed"
    assert document["error"].startswith("Last re-index failed: Indexing was interrupted")
    assert _chunk_ids(engine, indexed_pdf["id"]) == before


def test_worker_that_lost_its_lease_cannot_overwrite_the_new_owner(client, collection_id, engine, settings):
    """Fencing: a stalled worker finishing late must not commit over the worker that took over."""
    document = upload_file(client, collection_id, "notes.txt", b"contested text").json()["document"]
    stalled = claim_next(engine, settings)
    with engine.begin() as conn:
        conn.execute(update(jobs).values(lease_expires_at=utcnow() - timedelta(seconds=1)))
    successor = claim_next(engine, settings)
    assert successor is not None and successor.attempts == 2

    process_job(engine, settings, stalled)  # finishes its work, but its claim is stale
    assert _chunk_ids(engine, document["id"]) == []
    job = _job(engine, document["id"])
    assert (job.status, job.attempts) == ("running", 2)

    process_job(engine, settings, successor)
    assert _job(engine, document["id"]).status == "succeeded"
    assert _document(client, document["id"])["status"] == "indexed"


def test_heartbeat_renews_the_lease_while_a_job_runs(
    client, collection_id, engine, make_settings, monkeypatch
):
    settings = make_settings(job_lease_seconds=2)
    upload_file(client, collection_id, "notes.txt", b"slow text")
    job = claim_next(engine, settings)
    initial = _job(engine, job.document_id).lease_expires_at
    real_prepare = pipeline.prepare_index
    seen: list = []

    def slow_prepare(*args, **kwargs):
        time.sleep(2.6)  # longer than the lease: without a heartbeat the job would be stolen
        seen.append(_job(engine, job.document_id).lease_expires_at)
        seen.append(claim_next(engine, settings))
        return real_prepare(*args, **kwargs)

    monkeypatch.setattr(pipeline, "prepare_index", slow_prepare)
    process_job(engine, settings, job)

    assert seen[0] > initial
    assert seen[1] is None
    row = _job(engine, job.document_id)
    assert (row.status, row.attempts) == ("succeeded", 1)


def test_enqueue_never_creates_a_second_active_job(client, collection_id, engine):
    document = upload_file(client, collection_id, "notes.txt", b"text").json()["document"]
    with engine.begin() as conn:
        existing = conn.execute(select(jobs.c.id)).scalar_one()
        assert enqueue(conn, document["id"]) == existing
    with engine.connect() as conn:
        assert len(conn.execute(select(jobs)).all()) == 1


# --------------------------------------------------------------------------- worker thread


def _wait_for(predicate, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_thread_worker_indexes_uploads_in_the_background(make_settings, make_app):
    settings = make_settings(job_mode="thread")
    with TestClient(make_app(settings), headers=CSRF_HEADERS) as client:
        collection = create_collection(client)
        document = upload_file(client, collection, "biology.pdf", build_pdf(SAMPLE_PAGES)).json()["document"]
        assert _wait_for(lambda: _document(client, document["id"])["status"] in ("indexed", "failed"))
        assert _document(client, document["id"])["status"] == "indexed"
        assert any(t.name == "pp-index-worker" for t in threading.enumerate())
    # Leaving the lifespan stops the worker.
    assert _wait_for(lambda: not any(t.name == "pp-index-worker" for t in threading.enumerate()), 20)


def test_start_worker_is_idempotent_and_stop_joins(make_settings, make_app):
    settings = make_settings(job_mode="thread")
    engine = make_app(settings).state.engine

    def workers() -> list[threading.Thread]:
        return [t for t in threading.enumerate() if t.name == "pp-index-worker"]

    worker.start_worker(engine, settings)
    worker.start_worker(engine, settings)
    assert len(workers()) == 1
    worker.stop_worker()
    assert workers() == []
    worker.stop_worker()  # stopping twice is harmless


def test_manual_mode_starts_no_thread(client):
    assert not any(t.name == "pp-index-worker" for t in threading.enumerate())


def test_worker_polls_for_expired_leases(make_settings, make_app, monkeypatch):
    """A job orphaned by a crashed process is picked up by a running worker without any wake-up."""
    monkeypatch.setattr(worker, "POLL_SECONDS", 0.2)
    settings = make_settings()  # manual mode while the "crash" is staged
    app = make_app(settings)
    with TestClient(app, headers=CSRF_HEADERS) as client:
        collection = create_collection(client)
        document = upload_file(client, collection, "notes.txt", b"orphaned text").json()["document"]
        _crash_while_running(app.state.engine, settings)

        worker.start_worker(app.state.engine, make_settings(job_mode="thread"))
        assert _wait_for(lambda: _document(client, document["id"])["status"] == "indexed")


def test_stale_worker_cannot_flip_a_finished_document_back_to_processing(
    client, collection_id, engine, settings
):
    """A stalled worker that resumes after its successor finished must change nothing at all -
    in particular not the status, or the document would be stuck in ``processing`` forever."""
    document = upload_file(client, collection_id, "notes.txt", b"contested text").json()["document"]
    stalled = claim_next(engine, settings)
    with engine.begin() as conn:
        conn.execute(update(jobs).values(lease_expires_at=utcnow() - timedelta(seconds=1)))
    successor = claim_next(engine, settings)
    process_job(engine, settings, successor)
    finished = _document(client, document["id"])
    chunk_ids = _chunk_ids(engine, document["id"])
    assert finished["status"] == "indexed"

    process_job(engine, settings, stalled)

    assert _document(client, document["id"]) == finished  # status, timestamps, counts: untouched
    assert _chunk_ids(engine, document["id"]) == chunk_ids
    job = _job(engine, document["id"])
    assert (job.status, job.attempts) == ("succeeded", 2)
    assert run_pending_jobs(engine, settings) == 0


def test_index_document_without_ownership_writes_nothing(client, collection_id, engine, settings):
    document = upload_file(client, collection_id, "notes.txt", b"text").json()["document"]
    assert pipeline.index_document(engine, settings, document["id"], still_owned=lambda _conn: False) is False
    assert _document(client, document["id"])["status"] == "uploaded"
