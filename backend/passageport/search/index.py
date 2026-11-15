"""In-memory search index of one collection, and the cache that keeps such indexes fresh.

SQL is the source of truth. An index is a derived, read-only snapshot: the chunk rows, their
embedding matrix and BM25 postings. Every chunk change bumps ``collections.index_version`` in the
same transaction, so comparing that number (plus the embedding model version) on each request is
enough to know whether a cached snapshot is still exact — in this process, in other worker
processes, and after a restart. No invalidation message has to reach anyone for correctness.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from sqlalchemy import Connection, func, select

from passageport.db.access import collection_index_version, load_indexed_chunks
from passageport.db.schema import chunks as chunks_table
from passageport.domain import IndexedChunk
from passageport.search.bm25 import BM25Index, KeywordHit
from passageport.search.tokenize import tokenize

VECTOR_SEARCH = "exact cosine (brute force over a float32 matrix)"
MAX_CACHED_COLLECTIONS = 16


@dataclass(frozen=True, slots=True)
class IndexStats:
    chunks: int
    documents: int
    vocabulary: int
    average_chunk_tokens: float
    build_ms: float
    # Documents whose chunks were embedded by another model version and are therefore not searchable.
    stale_documents: int


class CollectionIndex:
    """Immutable after construction; safe to share between request threads."""

    def __init__(
        self,
        collection_id: str,
        index_version: int,
        embedding_version: str,
        chunks: Sequence[IndexedChunk],
        stale_documents: int = 0,
    ) -> None:
        started = time.perf_counter()
        self.collection_id = collection_id
        self.index_version = index_version
        self.embedding_version = embedding_version
        self.chunks: list[IndexedChunk] = list(chunks)
        count = len(self.chunks)
        self.matrix: np.ndarray = (
            np.stack([c.embedding for c in self.chunks]).astype(np.float32, copy=False)
            if count
            else np.zeros((0, 0), dtype=np.float32)
        )
        self.bm25 = BM25Index([tokenize(c.text) for c in self.chunks])
        # Rank of every row in chunk-id order: the deterministic tie-breaker of every ranking.
        self.tiebreak = np.empty(count, dtype=np.int64)
        self.tiebreak[
            np.argsort(np.array([c.chunk_id for c in self.chunks], dtype=object), kind="stable")
        ] = np.arange(count)
        rows_by_document: dict[str, list[int]] = {}
        for row, chunk in enumerate(self.chunks):
            rows_by_document.setdefault(chunk.document_id, []).append(row)
        self._rows_by_document = {
            doc: np.asarray(rows, dtype=np.int64) for doc, rows in rows_by_document.items()
        }
        self.stats = IndexStats(
            chunks=count,
            documents=len(rows_by_document),
            vocabulary=self.bm25.vocabulary_size,
            average_chunk_tokens=float(np.mean([c.token_count for c in self.chunks])) if count else 0.0,
            build_ms=(time.perf_counter() - started) * 1000.0,
            stale_documents=stale_documents,
        )

    def __len__(self) -> int:
        return len(self.chunks)

    def mask_for(self, document_ids: Sequence[str] | None) -> np.ndarray | None:
        """Boolean row mask for a document filter; ``None`` means "no filter"."""
        if document_ids is None:
            return None
        mask = np.zeros(len(self.chunks), dtype=bool)
        for document_id in document_ids:
            rows = self._rows_by_document.get(document_id)
            if rows is not None:
                mask[rows] = True
        return mask

    def keyword(
        self, terms: Sequence[str], *, k1: float, b: float, limit: int, mask: np.ndarray | None = None
    ) -> list[KeywordHit]:
        return self.bm25.search(terms, k1=k1, b=b, limit=limit, mask=mask, tiebreak=self.tiebreak)

    def similarities(self, query_vector: np.ndarray) -> np.ndarray:
        """Cosine similarity of every row to the query (vectors are stored L2-normalized)."""
        if not len(self.chunks):
            return np.zeros(0, dtype=np.float32)
        if query_vector.shape[0] != self.matrix.shape[1]:
            raise ValueError("query vector and index have different dimensions")
        return self.matrix @ query_vector.astype(np.float32, copy=False)

    def semantic(
        self, similarities: np.ndarray, *, limit: int, mask: np.ndarray | None = None
    ) -> list[tuple[int, float]]:
        """Top ``limit`` rows by similarity, ties ordered by chunk id."""
        candidates = np.arange(len(self.chunks)) if mask is None else np.flatnonzero(mask)
        if not len(candidates) or limit <= 0:
            return []
        order = np.lexsort((self.tiebreak[candidates], -similarities[candidates]))[:limit]
        return [(int(row), float(similarities[row])) for row in candidates[order]]


def build_index(conn: Connection, collection_id: str, embedding_version: str) -> CollectionIndex:
    """Read one consistent-enough snapshot from SQL.

    The version is read *before* the chunks. If a writer commits in between, the snapshot is newer
    than its label, which only costs one redundant rebuild on the next request; it can never be
    served as current while being older than the database.
    """
    index_version = collection_index_version(conn, collection_id)
    rows = load_indexed_chunks(conn, collection_id, embedding_version)
    stale = conn.execute(
        select(func.count(func.distinct(chunks_table.c.document_id))).where(
            chunks_table.c.collection_id == collection_id,
            chunks_table.c.embedding_version != embedding_version,
        )
    ).scalar()
    return CollectionIndex(
        collection_id, index_version, embedding_version, rows, stale_documents=int(stale or 0)
    )


class IndexCache:
    """Thread-safe LRU of collection indexes, validated against the database on every use."""

    def __init__(self, capacity: int = MAX_CACHED_COLLECTIONS) -> None:
        self._capacity = capacity
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, CollectionIndex] = OrderedDict()
        self._build_locks: dict[str, threading.Lock] = {}

    def _current(
        self, collection_id: str, index_version: int, embedding_version: str
    ) -> CollectionIndex | None:
        with self._lock:
            entry = self._entries.get(collection_id)
            if (
                entry is not None
                and entry.index_version == index_version
                and entry.embedding_version == embedding_version
            ):
                self._entries.move_to_end(collection_id)
                return entry
            return None

    def get(
        self, conn: Connection, collection_id: str, embedding_version: str
    ) -> tuple[CollectionIndex, bool]:
        """The index matching the database right now, and whether it came from the cache."""
        index_version = collection_index_version(conn, collection_id)
        entry = self._current(collection_id, index_version, embedding_version)
        if entry is not None:
            return entry, True
        with self._lock:
            build_lock = self._build_locks.setdefault(collection_id, threading.Lock())
        with build_lock:  # concurrent requests for the same collection share one build
            entry = self._current(collection_id, index_version, embedding_version)
            if entry is not None:
                return entry, True
            entry = build_index(conn, collection_id, embedding_version)
            with self._lock:
                self._entries[collection_id] = entry
                self._entries.move_to_end(collection_id)
                while len(self._entries) > self._capacity:
                    evicted, _ = self._entries.popitem(last=False)
                    self._build_locks.pop(evicted, None)
            return entry, False

    def invalidate(self, collection_id: str) -> None:
        with self._lock:
            self._entries.pop(collection_id, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._build_locks.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def __contains__(self, collection_id: str) -> bool:
        with self._lock:
            return collection_id in self._entries


_cache = IndexCache()


def get_index(conn: Connection, collection_id: str, embedding_version: str) -> tuple[CollectionIndex, bool]:
    return _cache.get(conn, collection_id, embedding_version)


def invalidate(collection_id: str) -> None:
    """Drop a cached index early to free memory (e.g. after a collection is deleted).

    Only a hint: a stale entry would be detected by its version on the next request anyway.
    """
    _cache.invalidate(collection_id)


def clear_cache() -> None:
    _cache.clear()
