"""Engine creation. SQLite (default, local) and PostgreSQL are both supported."""

from __future__ import annotations

from sqlalchemy import Engine, create_engine, event

from passageport.config import Settings
from passageport.db.schema import metadata


def create_db_engine(settings: Settings) -> Engine:
    url = settings.resolved_database_url
    if url.startswith("sqlite"):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

        @event.listens_for(engine, "connect")
        def _pragmas(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

    else:
        # prepare_threshold=None: managed Postgres is usually reached through a transaction-mode
        # pooler (PgBouncer), which does not support server-side prepared statements.
        engine = create_engine(
            url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=5,
            pool_recycle=300,
            connect_args={"prepare_threshold": None},
        )
    metadata.create_all(engine)
    return engine
