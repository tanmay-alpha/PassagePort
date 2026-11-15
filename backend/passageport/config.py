"""Runtime configuration. Every setting is read from a ``PP_``-prefixed environment variable."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ALLOWED_EXTENSIONS: tuple[str, ...] = (".pdf", ".txt", ".md", ".docx")


class Settings(BaseSettings):
    # env_ignore_empty: `PP_STATIC_DIR=` must mean "unset", not Path("."), which would serve the CWD.
    model_config = SettingsConfigDict(
        env_prefix="PP_", env_file=".env", extra="ignore", env_ignore_empty=True
    )

    # --- storage -----------------------------------------------------------
    data_dir: Path = Path("./data")
    # SQLAlchemy URL. Empty -> sqlite file inside data_dir. Postgres: postgresql+psycopg://...
    database_url: str = ""
    # Where original uploads live: "fs" (data_dir/blobs) or "db" (blobs table, for hosts without a disk).
    blob_backend: Literal["fs", "db"] = "fs"

    # --- access control ----------------------------------------------------
    # local: single implicit user, only loopback Host headers are served.
    # accounts: username/password accounts, cookie sessions, per-user isolation.
    auth_mode: Literal["local", "accounts"] = "local"
    local_allowed_hosts: list[str] = ["localhost", "127.0.0.1", "[::1]"]
    allow_signup: bool = True
    signup_code: SecretStr | None = None
    allow_guests: bool = False
    guest_ttl_hours: int = 24
    # Guest accounts that may exist at the same time, server-wide. Counted in the database under a
    # lock, so it holds across instances. Anonymous visitors can then store at most max_guests x the
    # per-user quotas; further "continue as guest" requests get 429 until older guests expire.
    max_guests: int = Field(default=100, ge=1)
    session_ttl_hours: int = 24 * 14
    cookie_secure: bool = True
    cors_origins: list[str] = []

    # --- limits ------------------------------------------------------------
    max_upload_mb: float = 25
    max_pages: int = 1500
    max_document_chars: int = 4_000_000
    max_collections_per_user: int = 100
    max_documents_per_user: int = 300
    max_storage_mb_per_user: int = 500
    max_query_chars: int = 1000
    # Server-wide ceiling on the size of the database in MB; 0 = none. Once reached, uploads are
    # refused (507) and queued documents fail instead of being indexed, so open sign-up or guest
    # access cannot fill a size-limited database. Measured with pg_database_size() on PostgreSQL and
    # the page count on SQLite. Includes the original files when blob_backend is "db".
    max_database_mb: int = Field(default=0, ge=0)
    rate_limit_per_minute: int = 120  # per user, search/ask/compare/lab endpoints

    # --- models ------------------------------------------------------------
    embedding_backend: Literal["fastembed", "sentence-transformers", "hashing"] = "fastembed"
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    reranker_backend: Literal["fastembed", "sentence-transformers", "none"] = "fastembed"
    reranker_model: str = "Xenova/ms-marco-MiniLM-L-6-v2"
    model_cache_dir: Path | None = None
    embed_batch_size: int = Field(default=32, ge=1)

    # --- chunking ----------------------------------------------------------
    chunk_max_tokens: int = 256
    chunk_overlap_tokens: int = 0

    # --- retrieval defaults (overridable per request in Search Lab) ---------
    search_top_k: int = 8
    search_candidates: int = 30  # per retriever, before fusion
    rrf_k: int = 60
    lexical_weight: float = 1.0
    vector_weight: float = 1.0
    rerank_by_default: bool = True
    rerank_candidates: int = 20
    bm25_k1: float = 1.2
    bm25_b: float = 0.75
    # Calibrated for BGE-small on the mini corpus; see docs/SEARCH_EVALUATION.md.
    # This is a retrieval sufficiency heuristic, not a probability or factual-verification score.
    min_vector_similarity: float = 0.70
    min_rerank_score: float = 0.0

    # --- optional LLM (any OpenAI-compatible chat-completions endpoint) -----
    llm_base_url: str = ""
    llm_api_key: SecretStr | None = None
    llm_model: str = ""
    llm_timeout_seconds: float = 60
    llm_max_evidence: int = 6

    # --- jobs --------------------------------------------------------------
    # thread: in-process worker thread. manual: nothing runs until run_pending_jobs() (tests).
    job_mode: Literal["thread", "manual"] = "thread"
    job_lease_seconds: int = Field(default=60, ge=1)  # renewed by a heartbeat while a job runs
    job_max_attempts: int = Field(default=2, ge=1)

    log_level: str = "INFO"
    # Directory with the built frontend (index.html + assets). Served at / when it exists.
    static_dir: Path | None = None
    parse_timeout_seconds: int = 120  # parsing runs in a killable subprocess
    # Evaluation report shown in Search Lab. Empty -> the report bundled with the package.
    eval_report_path: Path | None = None

    @property
    def resolved_database_url(self) -> str:
        """PP_DATABASE_URL (``postgres://`` URLs are normalized to the psycopg driver), else SQLite."""
        url = self.database_url
        if not url:
            return f"sqlite:///{(self.data_dir / 'passageport.db').as_posix()}"
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix) :]
        return url

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_model)


@lru_cache
def get_settings() -> Settings:
    return Settings()
