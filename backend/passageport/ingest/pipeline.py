"""Indexing pipeline: stored file -> pages -> chunks -> embeddings -> one atomic swap.

All slow work (parsing in a child process, chunking, embedding) happens outside any database
transaction. The result is then written in a single transaction that replaces the document's
previous pages and chunks, so readers see either the complete old index or the complete new one,
and a failure at any point leaves the previous index untouched.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from sqlalchemy import Connection, Engine, delete, insert, select, update

from passageport import parsing
from passageport.chunking import chunk_id, chunk_pages, chunker_version
from passageport.config import Settings
from passageport.db.repos import bump_index_version
from passageport.db.schema import chunks, documents, pages, utcnow
from passageport.domain import ChunkDraft, ParsedPage
from passageport.ml.protocols import to_blob
from passageport.ml.registry import get_embedder
from passageport.storage.blobs import BlobNotFoundError, get_blob_store

log = logging.getLogger("passageport.ingest")

GENERIC_FAILURE = "Indexing failed because of an unexpected server error. Try re-indexing the document."
REINDEX_FAILURE_PREFIX = "Last re-index failed: "
_INSERT_BATCH = 500


class IndexingError(Exception):
    """A deterministic indexing failure with a user-safe message. Retrying cannot help."""

    def __init__(self, user_message: str) -> None:
        super().__init__(user_message)
        self.user_message = user_message


@dataclass(frozen=True, slots=True)
class PreparedIndex:
    """Everything the final transaction writes, computed up front."""

    pages: list[ParsedPage]
    drafts: list[ChunkDraft]
    embeddings: np.ndarray  # (len(drafts), dimensions) float32
    embedding_version: str
    chunker_version: str


def prepare_index(kind: str, title: str, data: bytes, settings: Settings) -> PreparedIndex:
    """Parse, chunk and embed one document. Touches no database."""
    parsed = parsing.parse_document(kind, data, settings, title=title)
    embedder = get_embedder()
    drafts = chunk_pages(parsed, embedder, settings)
    if not drafts:
        raise IndexingError("This document contains no text that can be indexed.")
    batches: list[np.ndarray] = []
    for start in range(0, len(drafts), settings.embed_batch_size):
        texts = [draft.text for draft in drafts[start : start + settings.embed_batch_size]]
        batches.append(np.asarray(embedder.embed_documents(texts), dtype=np.float32))
    embeddings = np.concatenate(batches)
    if embeddings.shape != (len(drafts), embedder.dimensions):
        raise RuntimeError("embedding backend returned an unexpected shape")
    return PreparedIndex(
        pages=parsed,
        drafts=drafts,
        embeddings=embeddings,
        embedding_version=embedder.version,
        chunker_version=chunker_version(settings),
    )


def store_index(conn: Connection, document_id: str, expected_sha256: str, prepared: PreparedIndex) -> bool:
    """Swap in a freshly built index. Must run inside one transaction.

    Returns False, writing nothing, when the document was deleted or its content changed while
    the index was being built.
    """
    document = conn.execute(
        select(documents.c.collection_id, documents.c.sha256).where(documents.c.id == document_id)
    ).first()
    if document is None or document.sha256 != expected_sha256:
        return False

    conn.execute(delete(chunks).where(chunks.c.document_id == document_id))
    conn.execute(delete(pages).where(pages.c.document_id == document_id))
    conn.execute(
        insert(pages),
        [
            {"document_id": document_id, "page_number": p.number, "label": p.label, "text": p.text}
            for p in prepared.pages
        ],
    )
    rows = [
        {
            "id": chunk_id(document_id, draft, prepared.chunker_version),
            "document_id": document_id,
            "collection_id": document.collection_id,
            "ordinal": draft.ordinal,
            "page_number": draft.page_number,
            "char_start": draft.char_start,
            "char_end": draft.char_end,
            "text": draft.text,
            "token_count": draft.token_count,
            "embedding": to_blob(vector),
            "embedding_version": prepared.embedding_version,
        }
        for draft, vector in zip(prepared.drafts, prepared.embeddings, strict=True)
    ]
    for start in range(0, len(rows), _INSERT_BATCH):
        conn.execute(insert(chunks), rows[start : start + _INSERT_BATCH])

    now = utcnow()
    conn.execute(
        update(documents)
        .where(documents.c.id == document_id)
        .values(
            status="indexed",
            error=None,
            page_count=len(prepared.pages),
            chunk_count=len(rows),
            token_count=sum(draft.token_count for draft in prepared.drafts),
            embedding_version=prepared.embedding_version,
            chunker_version=prepared.chunker_version,
            indexed_at=now,
            updated_at=now,
        )
    )
    bump_index_version(conn, document.collection_id)
    return True


def record_failure(conn: Connection, document_id: str, message: str) -> None:
    """Persist the outcome of a failed indexing attempt.

    A document that was never indexed becomes ``failed``. A document whose *re-index* failed keeps
    its previous index and stays ``indexed``; the message is kept so the user can see why the
    refresh did not happen. The uploaded file is kept in both cases so the user can retry.
    """
    indexed_at = conn.execute(select(documents.c.indexed_at).where(documents.c.id == document_id)).first()
    if indexed_at is None:
        return
    if indexed_at[0] is not None:
        values = {"status": "indexed", "error": f"{REINDEX_FAILURE_PREFIX}{message}"}
    else:
        values = {"status": "failed", "error": message}
    conn.execute(update(documents).where(documents.c.id == document_id).values(**values, updated_at=utcnow()))


def index_document(
    engine: Engine,
    settings: Settings,
    document_id: str,
    *,
    still_owned: Callable[[Connection], bool] | None = None,
    fence: Callable[[Connection], bool] | None = None,
) -> bool:
    """Build and store the index of one document.

    Both callbacks belong to the job queue and make every write of this function conditional on
    the caller still owning the job: ``still_owned`` runs first in the transaction that marks the
    document ``processing``, ``fence`` runs first in the final transaction. A worker that lost
    its lease (it stalled, and another worker took the job over and may already have finished it)
    therefore changes nothing at all - neither the index nor the document's status.

    Returns False when nothing was written because of a veto or because the document no longer
    exists. Raises ``ParseError`` / ``IndexingError`` for failures the user can act on.
    """
    with engine.begin() as conn:
        if still_owned is not None and not still_owned(conn):
            return False
        conn.execute(
            update(documents)
            .where(documents.c.id == document_id)
            .values(status="processing", updated_at=utcnow())
        )
        document = conn.execute(select(documents).where(documents.c.id == document_id)).first()
    if document is None:
        return False

    try:
        data = get_blob_store(settings, engine).get(document.blob_key)
    except BlobNotFoundError:
        raise IndexingError("The original file is no longer available. Upload it again.") from None
    if hashlib.sha256(data).hexdigest() != document.sha256:
        raise IndexingError("The stored file is damaged. Delete this document and upload it again.")

    prepared = prepare_index(document.kind, document.title, data, settings)
    log.info(
        "built index for document %s: %d pages, %d chunks",
        document_id,
        len(prepared.pages),
        len(prepared.drafts),
    )

    with engine.begin() as conn:
        if fence is not None and not fence(conn):
            return False
        return store_index(conn, document_id, document.sha256, prepared)
