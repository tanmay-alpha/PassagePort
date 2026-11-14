"""Reads and writes for collections, documents and pages.

Every function that takes an ``owner_id`` filters by it in SQL, so a row that belongs to another
user is indistinguishable from a row that does not exist. Callers own the transaction.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import ColumnElement, Connection, Row, Select, case, delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError

from passageport.db.schema import chunks, collections, documents, jobs, pages, users, utcnow
from passageport.errors import ApiError, not_found

ACTIVE_JOB_STATUSES = ("queued", "running")
IN_PROGRESS_STATUSES = ("uploaded", "processing")


def new_id() -> str:
    return uuid.uuid4().hex


@dataclass(frozen=True, slots=True)
class Usage:
    collections: int
    documents: int
    chunks: int
    storage_bytes: int


def lock_user(conn: Connection, user_id: str) -> None:
    """Serialize the rest of this transaction with every other transaction that locks this user.

    Quota checks are "count, then insert": without this, concurrent requests of one user could
    all read the same count and each add one more. PostgreSQL holds the user row lock until commit.
    SQLite ignores FOR UPDATE, so first acquire its database-wide write lock with a no-op UPDATE.
    """
    if conn.dialect.name == "sqlite":
        conn.execute(update(users).where(users.c.id == user_id).values(is_guest=users.c.is_guest))
    conn.execute(select(users.c.id).where(users.c.id == user_id).with_for_update()).scalar_one()


# --------------------------------------------------------------------------- collections


def _count_where(condition: ColumnElement[bool]) -> ColumnElement[int]:
    return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)


def _collections_with_counts(owner_id: str) -> Select:
    """Collections of one user with per-collection document aggregates, in a single statement.

    Chunk and byte totals come from the denormalised counters on ``documents``, which the indexing
    transaction keeps in step with the ``chunks`` table.
    """
    stats = (
        select(
            documents.c.collection_id.label("collection_id"),
            func.count().label("document_count"),
            _count_where(documents.c.status == "indexed").label("indexed_count"),
            _count_where(documents.c.status.in_(IN_PROGRESS_STATUSES)).label("processing_count"),
            _count_where(documents.c.status == "failed").label("failed_count"),
            func.coalesce(func.sum(documents.c.chunk_count), 0).label("chunk_count"),
            func.coalesce(func.sum(documents.c.size_bytes), 0).label("size_bytes"),
        )
        .where(documents.c.owner_id == owner_id)
        .group_by(documents.c.collection_id)
        .subquery("stats")
    )
    return (
        select(
            collections.c.id,
            collections.c.name,
            collections.c.description,
            collections.c.created_at,
            collections.c.updated_at,
            func.coalesce(stats.c.document_count, 0).label("document_count"),
            func.coalesce(stats.c.indexed_count, 0).label("indexed_count"),
            func.coalesce(stats.c.processing_count, 0).label("processing_count"),
            func.coalesce(stats.c.failed_count, 0).label("failed_count"),
            func.coalesce(stats.c.chunk_count, 0).label("chunk_count"),
            func.coalesce(stats.c.size_bytes, 0).label("size_bytes"),
        )
        .select_from(collections.outerjoin(stats, stats.c.collection_id == collections.c.id))
        .where(collections.c.owner_id == owner_id)
    )


def list_collections(conn: Connection, owner_id: str) -> list[Row]:
    query = _collections_with_counts(owner_id).order_by(func.lower(collections.c.name), collections.c.name)
    return list(conn.execute(query).all())


def get_collection(conn: Connection, owner_id: str, collection_id: str) -> Row:
    row = conn.execute(_collections_with_counts(owner_id).where(collections.c.id == collection_id)).first()
    if row is None:
        raise not_found("Collection")
    return row


def _name_conflict() -> ApiError:
    return ApiError(409, "conflict", "A collection with this name already exists.")


def _name_taken(conn: Connection, owner_id: str, name: str, except_id: str | None = None) -> bool:
    query = select(collections.c.id).where(collections.c.owner_id == owner_id, collections.c.name == name)
    if except_id is not None:
        query = query.where(collections.c.id != except_id)
    return conn.execute(query).first() is not None


def create_collection(
    conn: Connection, owner_id: str, name: str, description: str, max_collections: int
) -> str:
    lock_user(conn, owner_id)
    if _name_taken(conn, owner_id, name):
        raise _name_conflict()
    existing = conn.execute(
        select(func.count()).select_from(collections).where(collections.c.owner_id == owner_id)
    ).scalar_one()
    if existing >= max_collections:
        raise ApiError(
            409,
            "quota_exceeded",
            f"You have reached the limit of {max_collections} collections. "
            "Delete collections you no longer need to create more.",
        )
    collection_id = new_id()
    now = utcnow()
    try:
        conn.execute(
            insert(collections).values(
                id=collection_id,
                owner_id=owner_id,
                name=name,
                description=description,
                index_version=0,
                created_at=now,
                updated_at=now,
            )
        )
    except IntegrityError:
        # Lost a race with a concurrent request that created the same name.
        raise _name_conflict() from None
    return collection_id


def update_collection(
    conn: Connection, owner_id: str, collection_id: str, name: str | None, description: str | None
) -> None:
    values: dict[str, object] = {"updated_at": utcnow()}
    if name is not None:
        if _name_taken(conn, owner_id, name, except_id=collection_id):
            raise _name_conflict()
        values["name"] = name
    if description is not None:
        values["description"] = description
    try:
        result = conn.execute(
            update(collections)
            .where(collections.c.id == collection_id, collections.c.owner_id == owner_id)
            .values(**values)
        )
    except IntegrityError:
        raise _name_conflict() from None
    if result.rowcount == 0:
        raise not_found("Collection")


def delete_collection(conn: Connection, owner_id: str, collection_id: str) -> list[str]:
    """Delete a collection with everything in it. Returns the blob keys to remove after commit."""
    lock_user(conn, owner_id)  # include every upload committed before collecting its blob keys
    owned = conn.execute(
        select(collections.c.id).where(collections.c.id == collection_id, collections.c.owner_id == owner_id)
    ).first()
    if owned is None:
        raise not_found("Collection")
    document_ids = select(documents.c.id).where(documents.c.collection_id == collection_id)
    blob_keys = list(
        conn.execute(select(documents.c.blob_key).where(documents.c.collection_id == collection_id)).scalars()
    )
    # Explicit deletes, children first: correct even on a database where cascades are disabled.
    conn.execute(delete(chunks).where(chunks.c.collection_id == collection_id))
    conn.execute(delete(pages).where(pages.c.document_id.in_(document_ids)))
    conn.execute(delete(jobs).where(jobs.c.document_id.in_(document_ids)))
    conn.execute(delete(documents).where(documents.c.collection_id == collection_id))
    conn.execute(delete(collections).where(collections.c.id == collection_id))
    return blob_keys


def bump_index_version(conn: Connection, collection_id: str) -> None:
    """Invalidate cached search indexes of a collection. Call in the same transaction as any
    change to its chunks or to data shown with search results (document titles)."""
    conn.execute(
        update(collections)
        .where(collections.c.id == collection_id)
        .values(index_version=collections.c.index_version + 1, updated_at=utcnow())
    )


# --------------------------------------------------------------------------- documents


def list_documents(
    conn: Connection, owner_id: str, collection_id: str, status: str | None = None, q: str | None = None
) -> list[Row]:
    query = select(documents).where(
        documents.c.owner_id == owner_id, documents.c.collection_id == collection_id
    )
    if status:
        query = query.where(documents.c.status == status)
    if q:
        query = query.where(
            documents.c.title.icontains(q, autoescape=True)
            | documents.c.filename.icontains(q, autoescape=True)
        )
    return list(conn.execute(query.order_by(documents.c.created_at.desc(), documents.c.id.desc())).all())


def get_document(conn: Connection, owner_id: str, document_id: str) -> Row:
    row = conn.execute(
        select(documents).where(documents.c.id == document_id, documents.c.owner_id == owner_id)
    ).first()
    if row is None:
        raise not_found("Document")
    return row


def find_by_hash(conn: Connection, collection_id: str, sha256: str) -> Row | None:
    return conn.execute(
        select(documents).where(documents.c.collection_id == collection_id, documents.c.sha256 == sha256)
    ).first()


def insert_document(
    conn: Connection,
    *,
    owner_id: str,
    collection_id: str,
    title: str,
    filename: str,
    kind: str,
    size_bytes: int,
    sha256: str,
    blob_key: str,
) -> str:
    """Insert an ``uploaded`` document. Raises ``IntegrityError`` when the same bytes were added to
    the collection concurrently; the caller turns that into a duplicate response."""
    document_id = new_id()
    now = utcnow()
    conn.execute(
        insert(documents).values(
            id=document_id,
            collection_id=collection_id,
            owner_id=owner_id,
            title=title,
            filename=filename,
            kind=kind,
            size_bytes=size_bytes,
            sha256=sha256,
            blob_key=blob_key,
            status="uploaded",
            error=None,
            page_count=0,
            chunk_count=0,
            token_count=0,
            created_at=now,
            updated_at=now,
        )
    )
    conn.execute(update(collections).where(collections.c.id == collection_id).values(updated_at=now))
    return document_id


def rename_document(conn: Connection, owner_id: str, document_id: str, title: str) -> None:
    row = get_document(conn, owner_id, document_id)
    conn.execute(
        update(documents).where(documents.c.id == document_id).values(title=title, updated_at=utcnow())
    )
    # Search results carry the title, and cached indexes are keyed by this version.
    bump_index_version(conn, row.collection_id)


def delete_document(conn: Connection, owner_id: str, document_id: str) -> Row:
    """Delete a document and its index. Returns the deleted row (blob key, collection)."""
    row = get_document(conn, owner_id, document_id)
    conn.execute(delete(chunks).where(chunks.c.document_id == document_id))
    conn.execute(delete(pages).where(pages.c.document_id == document_id))
    conn.execute(delete(jobs).where(jobs.c.document_id == document_id))
    conn.execute(delete(documents).where(documents.c.id == document_id))
    bump_index_version(conn, row.collection_id)
    return row


def mark_for_reindex(conn: Connection, owner_id: str, document_id: str) -> None:
    """Move an indexed/failed document back to ``processing``. The conditional UPDATE makes two
    simultaneous re-index requests resolve to exactly one job."""
    get_document(conn, owner_id, document_id)
    result = conn.execute(
        update(documents)
        .where(documents.c.id == document_id, documents.c.status.in_(("indexed", "failed")))
        .values(status="processing", error=None, updated_at=utcnow())
    )
    if result.rowcount == 0:
        raise ApiError(409, "conflict", "This document is already being indexed.")


def get_page(conn: Connection, document_id: str, page_number: int) -> Row:
    row = conn.execute(
        select(pages).where(pages.c.document_id == document_id, pages.c.page_number == page_number)
    ).first()
    if row is None:
        raise not_found("Page")
    return row


def list_outline(conn: Connection, document_id: str) -> list[Row]:
    return list(
        conn.execute(
            select(pages.c.page_number, pages.c.label)
            .where(pages.c.document_id == document_id)
            .order_by(pages.c.page_number)
        ).all()
    )


# --------------------------------------------------------------------------- usage / maintenance


def user_usage(conn: Connection, owner_id: str) -> Usage:
    collection_count = conn.execute(
        select(func.count()).select_from(collections).where(collections.c.owner_id == owner_id)
    ).scalar_one()
    row = conn.execute(
        select(
            func.count(),
            func.coalesce(func.sum(documents.c.chunk_count), 0),
            func.coalesce(func.sum(documents.c.size_bytes), 0),
        ).where(documents.c.owner_id == owner_id)
    ).one()
    return Usage(
        collections=int(collection_count),
        documents=int(row[0]),
        chunks=int(row[1]),
        storage_bytes=int(row[2]),
    )


def pending_job_count(conn: Connection, owner_id: str) -> int:
    value = conn.execute(
        select(func.count())
        .select_from(jobs.join(documents, documents.c.id == jobs.c.document_id))
        .where(documents.c.owner_id == owner_id, jobs.c.status.in_(ACTIVE_JOB_STATUSES))
    ).scalar_one()
    return int(value)


def all_blob_keys(conn: Connection) -> set[str]:
    return set(conn.execute(select(documents.c.blob_key)).scalars())


def blob_keys_of_users(conn: Connection, user_ids: list[str]) -> list[str]:
    if not user_ids:
        return []
    return list(
        conn.execute(select(documents.c.blob_key).where(documents.c.owner_id.in_(user_ids))).scalars()
    )
