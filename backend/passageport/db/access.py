"""Ownership-checked reads used by search, ask, compare and lab.

Every function that takes a ``User`` enforces that the rows belong to that user and raises the same
404 for "missing" and "someone else's".
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import Connection, Row, select

from passageport.db.schema import chunks, collections, documents, pages
from passageport.domain import IndexedChunk, User
from passageport.errors import not_found
from passageport.ml.protocols import from_blob


def require_collection(conn: Connection, user: User, collection_id: str) -> Row:
    row = conn.execute(
        select(collections).where(collections.c.id == collection_id, collections.c.owner_id == user.id)
    ).first()
    if row is None:
        raise not_found("Collection")
    return row


def require_documents(conn: Connection, user: User, document_ids: Sequence[str]) -> list[Row]:
    """All requested documents, in request order. 404 unless every one belongs to ``user``."""
    wanted = list(dict.fromkeys(document_ids))
    if not wanted:
        return []
    rows = conn.execute(
        select(documents).where(documents.c.id.in_(wanted), documents.c.owner_id == user.id)
    ).all()
    by_id = {r.id: r for r in rows}
    if len(by_id) != len(wanted):
        raise not_found("Document")
    return [by_id[i] for i in wanted]


def collection_index_version(conn: Connection, collection_id: str) -> int:
    value = conn.execute(
        select(collections.c.index_version).where(collections.c.id == collection_id)
    ).scalar()
    return int(value or 0)


def _to_indexed(rows: Sequence[Row]) -> list[IndexedChunk]:
    return [
        IndexedChunk(
            chunk_id=r.id,
            document_id=r.document_id,
            document_title=r.title,
            document_kind=r.kind,
            page_number=r.page_number,
            page_label=r.label,
            char_start=r.char_start,
            char_end=r.char_end,
            text=r.text,
            token_count=r.token_count,
            embedding=from_blob(r.embedding),
        )
        for r in rows
    ]


_CHUNK_COLUMNS = (
    chunks.c.id,
    chunks.c.document_id,
    documents.c.title,
    documents.c.kind,
    chunks.c.page_number,
    pages.c.label,
    chunks.c.char_start,
    chunks.c.char_end,
    chunks.c.text,
    chunks.c.token_count,
    chunks.c.embedding,
)
_CHUNK_JOIN = chunks.join(documents, documents.c.id == chunks.c.document_id).join(
    pages,
    (pages.c.document_id == chunks.c.document_id) & (pages.c.page_number == chunks.c.page_number),
)


def load_indexed_chunks(conn: Connection, collection_id: str, embedding_version: str) -> list[IndexedChunk]:
    """Every searchable chunk of a collection, ordered by (document, ordinal).

    Chunks embedded with a different model version are skipped: their vectors are not comparable.
    The caller is responsible for having checked collection ownership.
    """
    rows = conn.execute(
        select(*_CHUNK_COLUMNS)
        .select_from(_CHUNK_JOIN)
        .where(chunks.c.collection_id == collection_id, chunks.c.embedding_version == embedding_version)
        .order_by(chunks.c.document_id, chunks.c.ordinal)
    ).all()
    return _to_indexed(rows)


def get_chunk_for_user(conn: Connection, user: User, chunk_id: str) -> IndexedChunk:
    rows = conn.execute(
        select(*_CHUNK_COLUMNS)
        .select_from(_CHUNK_JOIN)
        .where(chunks.c.id == chunk_id, documents.c.owner_id == user.id)
    ).all()
    if not rows:
        raise not_found("Passage")
    return _to_indexed(rows)[0]
