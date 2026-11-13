"""Collection index and its version-validated cache."""

from __future__ import annotations

import threading

import numpy as np
import pytest
from sqlalchemy import delete

from passageport.db.schema import chunks
from passageport.domain import IndexedChunk
from passageport.search import index as index_module
from passageport.search.index import CollectionIndex, IndexCache
from retrieval_helpers import KITCHEN_SECTIONS, NETWORK_SECTIONS, Workspace, handbook

pytest_plugins = ["retrieval_helpers"]


def _chunk(chunk_id: str, document_id: str, text: str, vector: list[float], tokens: int = 4) -> IndexedChunk:
    return IndexedChunk(
        chunk_id=chunk_id,
        document_id=document_id,
        document_title="T",
        document_kind="md",
        page_number=1,
        page_label="Section 1",
        char_start=0,
        char_end=len(text),
        text=text,
        token_count=tokens,
        embedding=np.asarray(vector, dtype=np.float32),
    )


def _index() -> CollectionIndex:
    return CollectionIndex(
        "c1",
        7,
        "test:v1",
        [
            _chunk("zz", "d1", "alpha beta", [1.0, 0.0], tokens=2),
            _chunk("aa", "d1", "alpha gamma", [1.0, 0.0], tokens=4),
            _chunk("mm", "d2", "delta epsilon", [0.0, 1.0], tokens=6),
        ],
    )


def test_statistics() -> None:
    index = _index()
    assert len(index) == 3
    assert index.matrix.shape == (3, 2)
    assert index.matrix.dtype == np.float32
    assert index.stats.chunks == 3
    assert index.stats.documents == 2
    assert index.stats.vocabulary == 5
    assert index.stats.average_chunk_tokens == pytest.approx(4.0)
    assert index.stats.build_ms >= 0
    assert (index.index_version, index.embedding_version) == (7, "test:v1")


def test_semantic_ranking_breaks_ties_by_chunk_id() -> None:
    index = _index()
    similarities = index.similarities(np.array([1.0, 0.0], dtype=np.float32))
    assert similarities.tolist() == [1.0, 1.0, 0.0]
    # Rows 0 ("zz") and 1 ("aa") tie; the smaller chunk id comes first.
    assert index.semantic(similarities, limit=3) == [(1, 1.0), (0, 1.0), (2, 0.0)]
    assert index.semantic(similarities, limit=1) == [(1, 1.0)]


def test_keyword_ranking_breaks_ties_by_chunk_id() -> None:
    index = _index()
    hits = index.keyword(["alpha"], k1=1.2, b=0.75, limit=5)
    assert [h.row for h in hits] == [1, 0]
    assert hits[0].score == pytest.approx(hits[1].score)


def test_document_mask() -> None:
    index = _index()
    assert index.mask_for(None) is None
    assert index.mask_for(["d2"]).tolist() == [False, False, True]
    assert index.mask_for(["unknown"]).tolist() == [False, False, False]
    similarities = index.similarities(np.array([1.0, 0.0], dtype=np.float32))
    assert index.semantic(similarities, limit=5, mask=index.mask_for(["d2"])) == [(2, 0.0)]


def test_empty_index() -> None:
    index = CollectionIndex("c1", 0, "test:v1", [])
    assert len(index) == 0
    assert index.stats.average_chunk_tokens == 0.0
    assert index.similarities(np.zeros(4, dtype=np.float32)).shape == (0,)
    assert index.keyword(["alpha"], k1=1.2, b=0.75, limit=5) == []


def test_dimension_mismatch_is_an_error() -> None:
    with pytest.raises(ValueError, match="dimensions"):
        _index().similarities(np.zeros(3, dtype=np.float32))


def test_cache_hit_then_rebuild_after_version_bump(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    cache = IndexCache()
    version = workspace.embedder.version
    with workspace.engine.connect() as conn:
        first, cached = cache.get(conn, collection_id, version)
        assert not cached
        assert len(first) == 6
        again, cached = cache.get(conn, collection_id, version)
        assert cached
        assert again is first

    workspace.document(collection_id, "Extra", ["One more passage about caching."])
    with workspace.engine.connect() as conn:
        rebuilt, cached = cache.get(conn, collection_id, version)
    assert not cached
    assert rebuilt is not first
    assert len(rebuilt) == 7
    assert rebuilt.index_version == first.index_version + 1


def test_cache_notices_deleted_chunks_through_the_version(workspace: Workspace) -> None:
    collection_id, network, _ = handbook(workspace)
    cache = IndexCache()
    with workspace.engine.connect() as conn:
        assert len(cache.get(conn, collection_id, workspace.embedder.version)[0]) == 6
    with workspace.engine.begin() as conn:
        conn.execute(delete(chunks).where(chunks.c.document_id == network))
    workspace.bump(collection_id)
    with workspace.engine.connect() as conn:
        index, cached = cache.get(conn, collection_id, workspace.embedder.version)
    assert not cached
    assert len(index) == 2


def test_cache_is_keyed_by_embedding_version_and_counts_stale_documents(workspace: Workspace) -> None:
    collection_id = workspace.collection()
    workspace.document(collection_id, "Current", NETWORK_SECTIONS)
    workspace.document(collection_id, "Old model", KITCHEN_SECTIONS, embedding_version="other:model:8")
    cache = IndexCache()
    with workspace.engine.connect() as conn:
        index, _ = cache.get(conn, collection_id, workspace.embedder.version)
        assert len(index) == 4
        assert index.stats.stale_documents == 1
        other, cached = cache.get(conn, collection_id, "other:model:8")
    assert not cached
    assert len(other) == 2
    assert other.stats.stale_documents == 1


def test_invalidate_drops_the_entry(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    cache = IndexCache()
    with workspace.engine.connect() as conn:
        cache.get(conn, collection_id, workspace.embedder.version)
        assert collection_id in cache
        cache.invalidate(collection_id)
        assert collection_id not in cache
        assert cache.get(conn, collection_id, workspace.embedder.version)[1] is False
    cache.invalidate("never-cached")  # a hint, never an error


def test_module_level_invalidate(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    with workspace.engine.connect() as conn:
        assert index_module.get_index(conn, collection_id, workspace.embedder.version)[1] is False
        assert index_module.get_index(conn, collection_id, workspace.embedder.version)[1] is True
        index_module.invalidate(collection_id)
        assert index_module.get_index(conn, collection_id, workspace.embedder.version)[1] is False


def test_lru_eviction(workspace: Workspace) -> None:
    ids = []
    for i in range(3):
        collection_id = workspace.collection(f"C{i}")
        workspace.document(collection_id, "Doc", [f"passage number {i}"])
        ids.append(collection_id)
    cache = IndexCache(capacity=2)
    version = workspace.embedder.version
    with workspace.engine.connect() as conn:
        cache.get(conn, ids[0], version)
        cache.get(conn, ids[1], version)
        cache.get(conn, ids[0], version)  # ids[0] is now the most recently used
        cache.get(conn, ids[2], version)
    assert len(cache) == 2
    assert ids[0] in cache
    assert ids[1] not in cache
    assert ids[2] in cache


def test_concurrent_requests_share_one_build(workspace: Workspace, monkeypatch: pytest.MonkeyPatch) -> None:
    collection_id, _, _ = handbook(workspace)
    cache = IndexCache()
    builds = []
    original = index_module.build_index

    def counting(conn, collection, version):
        builds.append(collection)
        return original(conn, collection, version)

    monkeypatch.setattr(index_module, "build_index", counting)
    results = []

    def worker() -> None:
        with workspace.engine.connect() as conn:
            results.append(cache.get(conn, collection_id, workspace.embedder.version)[0])

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(builds) == 1
    assert len({id(r) for r in results}) == 1
