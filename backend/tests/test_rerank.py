"""Cross-encoder re-ranking through the search API, with a scripted re-ranker."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from passageport.search import service
from retrieval_helpers import FakeReranker, Workspace, handbook

pytest_plugins = ["retrieval_helpers"]


def _prefers(word: str) -> FakeReranker:
    return FakeReranker(lambda _query, passage: 5.0 if word in passage else -5.0)


def test_reranker_reorders_the_fused_results(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    payload = {"query": "reset link", "collection_id": collection_id}
    plain = workspace.ok("/api/search", payload | {"rerank": False})
    assert "reset link" in plain["results"][0]["text"]
    assert plain["settings"]["reranked"] is False

    reranker = _prefers("basil")
    workspace.use_reranker(reranker)
    reranked = workspace.ok("/api/search", payload)
    top = reranked["results"][0]
    assert "basil" in top["text"]
    assert top["scores"]["rerank"] == 5.0
    assert [h["scores"]["rerank"] for h in reranked["results"][1:]] == [-5.0] * (len(reranked["results"]) - 1)
    assert reranked["settings"]["reranked"] is True
    assert reranked["settings"]["reranker"] == "test:fake-reranker"
    assert reranked["timings_ms"]["rerank"] >= 0
    # Fusion scores are kept, so the change in order is explainable.
    assert top["scores"]["fused"] < max(h["scores"]["fused"] for h in reranked["results"])
    assert len(reranker.calls) == 1
    assert reranker.calls[0][0] == "reset link"


def test_rerank_can_be_disabled_per_request(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    reranker = _prefers("basil")
    workspace.use_reranker(reranker)
    body = workspace.ok("/api/search", {"query": "reset link", "collection_id": collection_id, "rerank": False})
    assert reranker.calls == []
    assert body["settings"]["reranked"] is False
    assert body["settings"]["reranker"] is None
    assert all(h["scores"]["rerank"] is None for h in body["results"])


def test_equal_rerank_scores_keep_a_deterministic_order(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    workspace.use_reranker(FakeReranker(lambda _q, _p: 1.0))
    body = workspace.ok("/api/search", {"query": "the reset link", "collection_id": collection_id})
    ids = [h["chunk_id"] for h in body["results"]]
    assert ids == sorted(ids)


def test_only_the_top_candidates_are_reranked(make_workspace: Callable[..., Workspace]) -> None:
    workspace = make_workspace(rerank_candidates=2)
    collection_id, _, _ = handbook(workspace)
    reranker = FakeReranker(lambda _q, passage: float(len(passage)))
    workspace.use_reranker(reranker)
    body = workspace.ok("/api/search", {"query": "reset link password", "collection_id": collection_id})
    assert len(reranker.calls[0][1]) == 2
    scores = [h["scores"]["rerank"] for h in body["results"]]
    assert scores[0] >= scores[1]
    assert all(s is None for s in scores[2:])
    # Passages outside the pool follow in their fused order.
    rest = [h["scores"]["fused"] for h in body["results"][2:]]
    assert rest == sorted(rest, reverse=True)


def test_rerank_score_decides_confidence(make_workspace: Callable[..., Workspace]) -> None:
    workspace = make_workspace(min_rerank_score=0.0)
    collection_id, _, _ = handbook(workspace)
    workspace.use_reranker(FakeReranker(lambda _q, _p: -3.0))
    weak = workspace.ok("/api/search", {"query": "reset link", "collection_id": collection_id})
    assert weak["low_confidence"] is True
    assert weak["notice"] == service.NOTICE_LOW_CONFIDENCE
    workspace.use_reranker(FakeReranker(lambda _q, passage: 2.0 if "reset link" in passage else -3.0))
    strong = workspace.ok("/api/search", {"query": "reset link", "collection_id": collection_id})
    assert strong["low_confidence"] is False
    assert strong["notice"] is None


def test_keyword_mode_can_be_reranked(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    workspace.use_reranker(_prefers("expires"))
    body = workspace.ok("/api/search", {"query": "reset link", "collection_id": collection_id, "mode": "keyword"})
    assert "expires" in body["results"][0]["text"]
    assert body["results"][0]["scores"]["rerank"] == pytest.approx(5.0)
    assert body["settings"]["mode"] == "keyword"
