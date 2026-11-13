"""Database-backed indexing queue with leases, and the in-process worker that drains it.

A job is claimed with one conditional UPDATE, so any number of worker threads or processes can
share the queue. While a job runs, a heartbeat keeps extending its lease; if the process dies the
lease runs out and the job becomes claimable again. ``attempts`` counts claims and doubles as a
fencing token: every write a worker makes is conditional on the attempt number it claimed, so a
worker that lost its lease can never overwrite the result of the one that took over.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import ColumnElement, Connection, Engine, and_, insert, or_, select, update

from passageport.auth.service import purge_expired_guests
from passageport.config import Settings
from passageport.db.repos import ACTIVE_JOB_STATUSES, new_id
from passageport.db.schema import jobs, utcnow
from passageport.ingest import pipeline
from passageport.parsing import ParseError
from passageport.storage.blobs import sweep_orphan_blobs

log = logging.getLogger("passageport.ingest")

POLL_SECONDS = 2.0  # how often an idle worker looks for expired leases / jobs from other processes
MAINTENANCE_INTERVAL_SECONDS = 600.0  # how often a running worker purges expired guest accounts
_STOP_JOIN_SECONDS = 15.0


def interrupted_message(attempts: int) -> str:
    return f"Indexing was interrupted {attempts} times and has been stopped. Try re-indexing the document."


# --------------------------------------------------------------------------- queue


@dataclass(frozen=True, slots=True)
class ClaimedJob:
    id: str
    document_id: str
    attempts: int  # the fencing token of this claim

    def _owned(self) -> ColumnElement[bool]:
        return and_(jobs.c.id == self.id, jobs.c.status == "running", jobs.c.attempts == self.attempts)

    def renew(self, conn: Connection, lease_seconds: float) -> bool:
        result = conn.execute(
            update(jobs)
            .where(self._owned())
            .values(lease_expires_at=utcnow() + timedelta(seconds=lease_seconds))
        )
        return result.rowcount == 1

    def finish(self, conn: Connection, status: str, error: str | None = None) -> bool:
        """Move the job out of ``running``. False when this claim no longer owns the job."""
        finished = status in ("succeeded", "failed")
        result = conn.execute(
            update(jobs)
            .where(self._owned())
            .values(
                status=status,
                error=error,
                lease_expires_at=None,
                finished_at=utcnow() if finished else None,
            )
        )
        return result.rowcount == 1


def enqueue(conn: Connection, document_id: str) -> str:
    """Queue an indexing job in the caller's transaction and return its id.

    A document never has two active jobs: if one is already queued or running it is returned.
    """
    existing = conn.execute(
        select(jobs.c.id).where(jobs.c.document_id == document_id, jobs.c.status.in_(ACTIVE_JOB_STATUSES))
    ).scalar()
    if existing is not None:
        return existing
    job_id = new_id()
    conn.execute(
        insert(jobs).values(
            id=job_id, document_id=document_id, status="queued", attempts=0, created_at=utcnow()
        )
    )
    notify()
    return job_id


def claim_next(engine: Engine, settings: Settings) -> ClaimedJob | None:
    """Claim the oldest runnable job: queued, or running with an expired lease (crashed worker).

    A job whose lease expired after its last allowed attempt is failed here instead.
    """
    while True:
        now = utcnow()
        claimable = or_(
            jobs.c.status == "queued",
            and_(jobs.c.status == "running", jobs.c.lease_expires_at < now),
        )
        with engine.begin() as conn:
            candidate = conn.execute(
                select(jobs.c.id, jobs.c.document_id, jobs.c.attempts)
                .where(claimable)
                .order_by(jobs.c.created_at, jobs.c.id)
                .limit(1)
            ).first()
            if candidate is None:
                return None
            still_claimable = and_(
                jobs.c.id == candidate.id, jobs.c.attempts == candidate.attempts, claimable
            )
            if candidate.attempts >= settings.job_max_attempts:
                message = interrupted_message(candidate.attempts)
                gave_up = conn.execute(
                    update(jobs)
                    .where(still_claimable)
                    .values(status="failed", error=message, lease_expires_at=None, finished_at=now)
                )
                if gave_up.rowcount == 1:
                    pipeline.record_failure(conn, candidate.document_id, message)
                    log.warning("job %s abandoned after %d attempts", candidate.id, candidate.attempts)
                continue
            claimed = conn.execute(
                update(jobs)
                .where(still_claimable)
                .values(
                    status="running",
                    attempts=jobs.c.attempts + 1,
                    lease_expires_at=now + timedelta(seconds=settings.job_lease_seconds),
                    started_at=now,
                    finished_at=None,
                )
            )
            if claimed.rowcount == 1:
                return ClaimedJob(candidate.id, candidate.document_id, candidate.attempts + 1)
        # Another worker claimed it between the SELECT and the UPDATE: look again.


class _Heartbeat:
    """Extends the lease of a running job from a side thread until stopped."""

    def __init__(self, engine: Engine, job: ClaimedJob, lease_seconds: float) -> None:
        self._engine = engine
        self._job = job
        self._lease_seconds = lease_seconds
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pp-job-heartbeat", daemon=True)

    def __enter__(self) -> _Heartbeat:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.wait(self._lease_seconds / 3):
            try:
                with self._engine.begin() as conn:
                    if not self._job.renew(conn, self._lease_seconds):
                        return  # lease lost; the fence in the final transaction stops the job
            except Exception as exc:
                log.warning("job heartbeat failed: %s", type(exc).__name__)


def _fail(engine: Engine, job: ClaimedJob, message: str, *, retry: bool) -> None:
    with engine.begin() as conn:
        if retry:
            job.finish(conn, "queued", message)
        elif job.finish(conn, "failed", message):
            pipeline.record_failure(conn, job.document_id, message)


def process_job(engine: Engine, settings: Settings, job: ClaimedJob) -> None:
    """Run one claimed job to an outcome. Never raises for document-level failures."""
    with _Heartbeat(engine, job, settings.job_lease_seconds):
        try:
            # Every write is conditional on this claim: the first one renews the lease, the last
            # one marks the job succeeded in the same transaction that swaps in the index.
            pipeline.index_document(
                engine,
                settings,
                job.document_id,
                still_owned=lambda conn: job.renew(conn, settings.job_lease_seconds),
                fence=lambda conn: job.finish(conn, "succeeded"),
            )
        except (ParseError, pipeline.IndexingError) as exc:
            # Deterministic: the same file fails the same way, so it is not retried.
            log.info("job %s failed: %s", job.id, type(exc).__name__)
            _fail(engine, job, exc.user_message, retry=False)
        except Exception as exc:
            # Possibly transient (database busy, model download). Log the type only: exception
            # messages can quote document text.
            log.error("job %s failed unexpectedly: %s", job.id, type(exc).__name__)
            _fail(engine, job, pipeline.GENERIC_FAILURE, retry=job.attempts < settings.job_max_attempts)


def run_pending_jobs(engine: Engine, settings: Settings) -> int:
    """Process every runnable job in the calling thread. Returns the number of jobs run."""
    count = 0
    while (job := claim_next(engine, settings)) is not None:
        process_job(engine, settings, job)
        count += 1
    return count


# --------------------------------------------------------------------------- worker thread


class _Worker:
    def __init__(self, engine: Engine, settings: Settings) -> None:
        self.engine = engine
        self._settings = settings
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pp-index-worker", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def wake(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=_STOP_JOIN_SECONDS)

    def _run(self) -> None:
        last_maintenance = time.monotonic()  # start_worker has just run it
        while not self._stop.is_set():
            self._wake.clear()
            try:
                while not self._stop.is_set() and (job := claim_next(self.engine, self._settings)):
                    process_job(self.engine, self._settings, job)
                if time.monotonic() - last_maintenance >= MAINTENANCE_INTERVAL_SECONDS:
                    # Without this a server that never restarts would keep guest data past its
                    # TTL until the next guest happens to sign in.
                    last_maintenance = time.monotonic()
                    purge_expired_guests(self.engine, self._settings)
            except Exception as exc:
                # Keep the worker alive through database hiccups; the next poll retries.
                log.error("index worker error: %s", type(exc).__name__)
            self._wake.wait(timeout=POLL_SECONDS)


class _WorkerSlot:
    """The one worker thread of this process, if any."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.worker: _Worker | None = None


_slot = _WorkerSlot()


def notify() -> None:
    """Wake the worker thread, if there is one. Call after committing a transaction that queued
    work; a missed or early wake-up only delays the job until the next poll."""
    worker = _slot.worker
    if worker is not None:
        worker.wake()


def run_startup_maintenance(engine: Engine, settings: Settings) -> None:
    """Housekeeping that is cheap and safe to repeat: remove blobs no document refers to and
    purge expired guest accounts. Failures are logged, never fatal."""
    for task in (sweep_orphan_blobs, purge_expired_guests):
        try:
            task(engine, settings)
        except Exception as exc:
            log.warning("startup maintenance step %s failed: %s", task.__name__, type(exc).__name__)


def start_worker(engine: Engine, settings: Settings) -> None:
    """Run startup maintenance and, in ``thread`` job mode, start the worker thread.

    Idempotent: a second call for the same engine does nothing. Jobs left ``running`` by a crashed
    process are picked up automatically once their lease expires.
    """
    with _slot.lock:
        current = _slot.worker
        if current is not None and current.engine is engine and current.is_alive():
            return
        if current is not None:
            current.stop()
            _slot.worker = None
        run_startup_maintenance(engine, settings)
        if settings.job_mode != "thread":
            return
        _slot.worker = _Worker(engine, settings)
        _slot.worker.start()


def stop_worker() -> None:
    """Stop the worker thread and wait for it. A job in flight is abandoned to its lease if it
    does not finish within the join timeout."""
    with _slot.lock:
        worker, _slot.worker = _slot.worker, None
    if worker is not None:
        worker.stop()
