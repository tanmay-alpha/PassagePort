"""Search Lab exposes the production stages without changing their response contract."""

from __future__ import annotations

from retrieval_helpers import FakeReranker, Workspace, handbook

from passageport.api.schemas import LabOut

pytest_plugins = ["retrieval_helpers"]


def test_lab_exposes_the_same_fused_ranking_as_search(workspace: Workspace) -> None:
    collection, _, _ = handbook(workspace)
    payload = {"query": "password reset link", "collection_id": collection, "rerank": False}
    search = workspace.ok("/api/search", payload)
    result = LabOut.model_validate(workspace.ok("/api/lab/search", payload))
    assert [hit.chunk_id for hit in result.fused.results[:8]] == [
        hit["chunk_id"] for hit in search["results"]
    ]
    assert result.keyword.results
    assert result.semantic.results
    assert result.reranked is None
    assert result.index.chunks > 0
    assert result.index.cached
    assert result.settings.reranked is False
    assert result.total_ms >= 0
    for stage in (result.keyword, result.semantic, result.fused):
        assert all(term in hit.text for hit in stage.results for term in hit.matched_terms)


def test_lab_applies_settings_and_shows_reranked_scores(workspace: Workspace) -> None:
    collection, _, _ = handbook(workspace)
    workspace.use_reranker(FakeReranker(lambda _q, p: float(len(p))))
    result = LabOut.model_validate(
        workspace.ok(
            "/api/lab/search",
            {
                "query": "password reset link",
                "collection_id": collection,
                "rrf_k": 20,
                "lexical_weight": 0.7,
                "vector_weight": 1.0,
                "candidates": 10,
            },
        )
    )
    assert result.settings.rrf_k == 20
    assert result.settings.lexical_weight == 0.7
    assert result.settings.vector_weight == 1.0
    assert result.settings.candidates == 10
    assert result.settings.reranked is True
    assert result.reranked is not None
    assert all(hit.scores.rerank is not None for hit in result.reranked.results)


def test_lab_skips_invalid_reranker_without_invalid_json_numbers(workspace: Workspace) -> None:
    collection, _, _ = handbook(workspace)
    workspace.use_reranker(FakeReranker(lambda _q, _p: float("nan")))
    result = LabOut.model_validate(
        workspace.ok(
            "/api/lab/search",
            {
                "query": "password reset link",
                "collection_id": collection,
            },
        )
    )
    assert result.reranked is None
    assert result.fused.results
    assert all(hit.scores.rerank is None for hit in result.fused.results)
    assert result.settings.reranked is False
