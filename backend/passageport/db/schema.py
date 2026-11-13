"""Database schema (SQLAlchemy Core). One transactional store holds metadata, page text,
chunks and their embeddings, so a document and its search index can never disagree."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    String,
    Table,
    Text,
    TypeDecorator,
    UniqueConstraint,
)


class UTCDateTime(TypeDecorator):
    """Timezone-aware UTC datetimes on every backend (SQLite drops tzinfo)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect):  # noqa: ANN001, ARG002
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime")
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect):  # noqa: ANN001, ARG002
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def utcnow() -> datetime:
    return datetime.now(UTC)


metadata = MetaData()

users = Table(
    "users",
    metadata,
    Column("id", String(32), primary_key=True),
    Column("username", String(64), nullable=False, unique=True),
    Column("password_hash", String(255), nullable=True),  # null: local user / guest
    Column("is_guest", Boolean, nullable=False, default=False),
    Column("created_at", UTCDateTime, nullable=False, default=utcnow),
)

sessions = Table(
    "sessions",
    metadata,
    Column("id", String(32), primary_key=True),
    Column("token_hash", String(64), nullable=False, unique=True),  # sha256 of the secret
    Column("user_id", String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("kind", String(8), nullable=False),  # "web" (cookie) | "api" (bearer token)
    Column("name", String(100), nullable=True),
    Column("created_at", UTCDateTime, nullable=False, default=utcnow),
    Column("expires_at", UTCDateTime, nullable=True),
)

collections = Table(
    "collections",
    metadata,
    Column("id", String(32), primary_key=True),
    Column("owner_id", String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("name", String(120), nullable=False),
    Column("description", String(500), nullable=False, default=""),
    # Bumped in the same transaction as any chunk change; in-memory search indexes key on it.
    Column("index_version", Integer, nullable=False, default=0),
    Column("created_at", UTCDateTime, nullable=False, default=utcnow),
    Column("updated_at", UTCDateTime, nullable=False, default=utcnow),
    UniqueConstraint("owner_id", "name", name="uq_collection_owner_name"),
)

documents = Table(
    "documents",
    metadata,
    Column("id", String(32), primary_key=True),
    Column(
        "collection_id",
        String(32),
        ForeignKey("collections.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("owner_id", String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("title", String(255), nullable=False),
    Column("filename", String(255), nullable=False),  # sanitized display name, never a path
    Column("kind", String(8), nullable=False),  # pdf | txt | md | docx
    Column("size_bytes", Integer, nullable=False),
    Column("sha256", String(64), nullable=False),
    Column("blob_key", String(80), nullable=False),
    Column("status", String(12), nullable=False),  # uploaded | processing | indexed | failed
    Column("error", Text, nullable=True),  # user-safe message from the last failed attempt
    Column("page_count", Integer, nullable=False, default=0),
    Column("chunk_count", Integer, nullable=False, default=0),
    Column("token_count", Integer, nullable=False, default=0),
    Column("embedding_version", String(160), nullable=True),
    Column("chunker_version", String(60), nullable=True),
    Column("created_at", UTCDateTime, nullable=False, default=utcnow),
    Column("updated_at", UTCDateTime, nullable=False, default=utcnow),
    Column("indexed_at", UTCDateTime, nullable=True),
    UniqueConstraint("collection_id", "sha256", name="uq_document_collection_hash"),
    Index("ix_documents_collection", "collection_id"),
)

# A "page" is the unit a citation points at: a PDF page, or a section of a text/Markdown/DOCX file.
pages = Table(
    "pages",
    metadata,
    Column(
        "document_id",
        String(32),
        ForeignKey("documents.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("page_number", Integer, primary_key=True),  # 1-based
    Column("label", String(200), nullable=False),  # "Page 3" or a section heading
    Column("text", Text, nullable=False),
)

chunks = Table(
    "chunks",
    metadata,
    # Deterministic: hash(document_id, page_number, char_start, char_end, chunker_version).
    Column("id", String(24), primary_key=True),
    Column(
        "document_id",
        String(32),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column(
        "collection_id",
        String(32),
        ForeignKey("collections.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("ordinal", Integer, nullable=False),
    Column("page_number", Integer, nullable=False),
    Column("char_start", Integer, nullable=False),  # offsets into pages.text
    Column("char_end", Integer, nullable=False),
    Column("text", Text, nullable=False),
    Column("token_count", Integer, nullable=False),
    Column("embedding", LargeBinary, nullable=False),  # float32 little-endian, L2-normalized
    Column("embedding_version", String(160), nullable=False),
    Index("ix_chunks_collection", "collection_id"),
    Index("ix_chunks_document", "document_id"),
)

jobs = Table(
    "jobs",
    metadata,
    Column("id", String(32), primary_key=True),
    Column(
        "document_id",
        String(32),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("status", String(10), nullable=False),  # queued | running | succeeded | failed
    Column("attempts", Integer, nullable=False, default=0),
    Column("error", Text, nullable=True),
    Column("lease_expires_at", UTCDateTime, nullable=True),
    Column("created_at", UTCDateTime, nullable=False, default=utcnow),
    Column("started_at", UTCDateTime, nullable=True),
    Column("finished_at", UTCDateTime, nullable=True),
    Index("ix_jobs_status", "status"),
)

blobs = Table(
    "blobs",
    metadata,
    Column("key", String(80), primary_key=True),
    Column("data", LargeBinary, nullable=False),
)
