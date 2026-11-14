"""POST /api/search: modes, filters, isolation, notices and confidence."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from passageport.search import index as index_module
from passageport.search import service
from retrieval_helpers import (
    BOB,
    KITCHEN_SECTIONS,
    NETWORK_SECTIONS,
    OUT_OF_SCOPE_QUERY,
    ConceptEmbedder,
    Workspace,
    handbook,
)

pytest_plugins = ["retrieval_helpers"]


def _search(workspace: Workspace, collection_id: str, query: str, **extra) -> dict:
    return workspace.ok("/api/search", {"query": query, "collection_id": collection_id, **extra})


def test_exact_identifier_is_found_by_keyword_search(workspace: Workspace) -> None:
    collection_id, network, _ = handbook(workspace)
    body = _search(workspace, collection_id, "ECONNRESET", mode="keyword")
    assert len(body["results"]) == 1
    hit = body["results"][0]
    assert hit["text"] == "The error ECONNRESET means the peer closed the connection abruptly."
    assert hit["document_id"] == network
    assert hit["rank"] == 1
    assert hit["matched_terms"] == ["ECONNRESET"]
    assert hit["scores"]["keyword"]["rank"] == 1
    assert hit["scores"]["keyword"]["score"] > 0
    assert hit["scores"]["semantic"] is None
    assert hit["scores"]["fused"] is None
    assert body["low_confidence"] is False
    assert body["notice"] is None


def test_hits_are_citations_into_the_page_text(workspace: Workspace) -> None:
    collection_id, _, kitchen = handbook(workspace)
    hit = _search(workspace, collection_id, "bread dough", mode="keyword")["results"][0]
    page_text = KITCHEN_SECTIONS[hit["page_number"] - 1]
    assert page_text[hit["char_start"] : hit["char_end"]] == hit["text"]
    assert hit["document_id"] == kitchen
    assert hit["document_title"] == "Kitchen notes"
    assert hit["document_kind"] == "txt"
    assert hit["locator_kind"] == "section"
    assert hit["page_label"] == "Section 1"
    assert hit["matched_terms"] == ["bread", "dough"]


def test_hybrid_finds_an_identifier_and_a_paraphrase(make_workspace: Callable[..., Workspace]) -> None:
    workspace = make_workspace(embedder=ConceptEmbedder(), min_vector_similarity=0.6)
    collection_id = workspace.collection()
    workspace.document(
        collection_id,
        "Garage manual",
        [
            "Have your car serviced once a year by a trained mechanic.\n"
            "The dashboard shows code P0420 when the catalytic converter is failing.\n"
            "Simmer the sauce and bake the bread.",
        ],
    )
    # No word of the query occurs in the passage: only the semantic retriever can find it.
    paraphrase = _search(workspace, collection_id, "automobile maintenance")
    top = paraphrase["results"][0]
    assert top["text"] == "Have your car serviced once a year by a trained mechanic."
    assert top["scores"]["keyword"] is None
    assert top["scores"]["semantic"]["rank"] == 1
    assert top["scores"]["semantic"]["score"] == pytest.approx(1.0)
    assert top["matched_terms"] == []
    assert paraphrase["low_confidence"] is False
    assert _search(workspace, collection_id, "automobile maintenance", mode="keyword")["results"] == []

    # The identifier means nothing to the embedder: only the keyword retriever can find it.
    identifier = _search(workspace, collection_id, "P0420")
    top = identifier["results"][0]
    assert "P0420" in top["text"]
    assert top["scores"]["keyword"]["rank"] == 1
    assert top["matched_terms"] == ["P0420"]
    assert identifier["low_confidence"] is False


def test_fused_score_is_the_weighted_rrf_of_both_ranks(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    body = _search(workspace, collection_id, "reset link password")
    settings = body["settings"]
    assert settings["mode"] == "hybrid"
    for hit in body["results"]:
        expected = sum(
            weight / (settings["rrf_k"] + stage["rank"])
            for weight, stage in (
                (settings["lexical_weight"], hit["scores"]["keyword"]),
                (settings["vector_weight"], hit["scores"]["semantic"]),
            )
            if stage is not None
        )
        assert hit["scores"]["fused"] == pytest.approx(expected)
    fused = [hit["scores"]["fused"] for hit in body["results"]]
    assert fused == sorted(fused, reverse=True)
    assert [hit["rank"] for hit in body["results"]] == list(range(1, len(fused) + 1))


def test_results_are_deterministic(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    first = _search(workspace, collection_id, "the reset link")
    index_module.clear_cache()
    second = _search(workspace, collection_id, "the reset link")
    assert [h["chunk_id"] for h in first["results"]] == [h["chunk_id"] for h in second["results"]]


def test_top_k_limits_results(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    assert len(_search(workspace, collection_id, "the", mode="semantic", top_k=2)["results"]) == 2
    assert len(_search(workspace, collection_id, "the", mode="semantic", top_k=50)["results"]) == 6


def test_document_filter(workspace: Workspace) -> None:
    collection_id, network, kitchen = handbook(workspace)
    everything = _search(workspace, collection_id, "minutes", mode="keyword")
    assert {h["document_id"] for h in everything["results"]} == {network, kitchen}
    only_kitchen = _search(workspace, collection_id, "minutes", mode="keyword", document_ids=[kitchen])
    assert [h["document_id"] for h in only_kitchen["results"]] == [kitchen]
    semantic = _search(workspace, collection_id, "minutes", mode="semantic", document_ids=[network], top_k=50)
    assert {h["document_id"] for h in semantic["results"]} == {network}
    assert len(semantic["results"]) == 4


def test_document_filter_rejects_documents_of_another_collection(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    other = workspace.collection("Other")
    foreign = workspace.document(other, "Elsewhere", ["Unrelated text."])
    response = workspace.post(
        "/api/search", {"query": "text", "collection_id": collection_id, "document_ids": [foreign]}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_other_users_cannot_search_a_collection_or_filter_by_its_documents(workspace: Workspace) -> None:
    collection_id, network, _ = handbook(workspace)
    bobs = workspace.collection("Bob's", owner=BOB)
    workspace.document(bobs, "Bob's notes", ["Bob's private passage about ECONNRESET."], owner=BOB)

    workspace.act_as(BOB)
    response = workspace.post("/api/search", {"query": "ECONNRESET", "collection_id": collection_id})
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Collection not found."}}
    response = workspace.post(
        "/api/search", {"query": "ECONNRESET", "collection_id": bobs, "document_ids": [network]}
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    # Bob still sees his own data, and only his own.
    own = _search(workspace, bobs, "ECONNRESET", mode="keyword")
    assert [h["text"] for h in own["results"]] == ["Bob's private passage about ECONNRESET."]


def test_unknown_collection_is_not_found(workspace: Workspace) -> None:
    response = workspace.post("/api/search", {"query": "x", "collection_id": "missing"})
    assert response.status_code == 404


def test_new_document_is_searchable_immediately(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    before = _search(workspace, collection_id, "kubernetes", mode="keyword")
    assert before["results"] == []
    assert before["low_confidence"] is True
    assert before["notice"] == service.NOTICE_NO_MATCH
    workspace.document(collection_id, "Cluster notes", ["Kubernetes schedules pods onto nodes."])
    after = _search(workspace, collection_id, "kubernetes", mode="keyword")
    assert [h["text"] for h in after["results"]] == ["Kubernetes schedules pods onto nodes."]
    assert after["settings"]["index_version"] == before["settings"]["index_version"] + 1


def test_empty_collection_notice(workspace: Workspace) -> None:
    body = _search(workspace, workspace.collection(), "anything")
    assert body["results"] == []
    assert body["low_confidence"] is True
    assert body["notice"] == service.NOTICE_NO_DOCUMENTS


def test_nothing_indexed_yet_notice(workspace: Workspace) -> None:
    collection_id = workspace.collection()
    workspace.document(collection_id, "Pending", ["text"], status="processing")
    body = _search(workspace, collection_id, "anything")
    assert body["results"] == []
    assert body["notice"] == service.NOTICE_INDEXING

    failed = workspace.collection("Failed")
    workspace.document(failed, "Broken", ["text"], status="failed")
    assert _search(workspace, failed, "anything")["notice"] == service.NOTICE_NOTHING_INDEXED


def test_stale_documents_are_excluded_with_a_notice(workspace: Workspace) -> None:
    collection_id = workspace.collection()
    workspace.document(collection_id, "Current", NETWORK_SECTIONS)
    stale = workspace.document(collection_id, "Old model", KITCHEN_SECTIONS, embedding_version="other:model:8")
    body = _search(workspace, collection_id, "ECONNRESET", mode="keyword")
    assert body["low_confidence"] is False
    assert body["notice"] == service.notice_stale(1)
    assert "1 document was indexed with a different embedding model" in body["notice"]
    # The stale document's text is not searchable in any mode.
    assert _search(workspace, collection_id, "tomato sauce basil", mode="keyword")["results"] == []
    filtered = _search(workspace, collection_id, "tomato", document_ids=[stale])
    assert filtered["results"] == []
    assert filtered["notice"] == service.NOTICE_SELECTION_EMPTY

    only_stale = workspace.collection("Only stale")
    workspace.document(only_stale, "Old model", KITCHEN_SECTIONS, embedding_version="other:model:8")
    body = _search(workspace, only_stale, "tomato")
    assert body["results"] == []
    assert body["notice"] == service.NOTICE_ALL_STALE


def test_out_of_scope_query_is_low_confidence(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    body = _search(workspace, collection_id, OUT_OF_SCOPE_QUERY)
    assert body["low_confidence"] is True
    assert body["notice"] == service.NOTICE_LOW_CONFIDENCE
    # Best-effort results are still returned, clearly flagged.
    assert body["results"]
    assert all(hit["scores"]["keyword"] is None for hit in body["results"])


def test_partial_keyword_match_alone_is_not_confident(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    # "minutes" occurs in the corpus, the other terms do not, and nothing is similar overall.
    body = _search(workspace, collection_id, "minutes of the parliamentary committee on fisheries", mode="keyword")
    assert body["results"]
    assert body["low_confidence"] is True
    full = _search(workspace, collection_id, "tomato basil", mode="keyword")
    assert full["low_confidence"] is False


def test_invalid_requests(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    too_long = "x" * (workspace.settings.max_query_chars + 1)
    for payload in (
        {"query": too_long, "collection_id": collection_id},
        {"query": "   ", "collection_id": collection_id},
        {"query": "", "collection_id": collection_id},
        {"query": "x", "collection_id": collection_id, "top_k": 0},
        {"query": "x", "collection_id": collection_id, "mode": "fuzzy"},
        {"query": "x", "collection_id": collection_id, "unknown": 1},
        {"collection_id": collection_id},
    ):
        response = workspace.post("/api/search", payload)
        assert response.status_code == 422, payload
        assert response.json()["error"]["code"] == "invalid_request"
    assert "maximum" in workspace.post("/api/search", {"query": too_long, "collection_id": collection_id}).text


def test_effective_settings_and_timings(workspace: Workspace) -> None:
    collection_id, _, _ = handbook(workspace)
    body = _search(workspace, collection_id, "password", top_k=3)
    settings = workspace.settings
    assert body["settings"] == {
        "mode": "hybrid",
        "top_k": 3,
        "candidates": settings.search_candidates,
        "rrf_k": settings.rrf_k,
        "lexical_weight": settings.lexical_weight,
        "vector_weight": settings.vector_weight,
        "reranked": False,
        "rerank_candidates": settings.rerank_candidates,
        "bm25_k1": settings.bm25_k1,
        "bm25_b": settings.bm25_b,
        "embedding_version": workspace.embedder.version,
        "reranker": None,
        "index_version": 2,
    }
    assert set(body["timings_ms"]) == {"index", "embed", "keyword", "semantic", "fuse", "rerank", "total"}
    assert body["timings_ms"]["total"] >= body["timings_ms"]["keyword"] >= 0
    assert body["timings_ms"]["rerank"] == 0.0
    assert body["query"] == "password"


def test_keyword_mode_does_not_embed_the_query(workspace: Workspace, monkeypatch: pytest.MonkeyPatch) -> None:
    collection_id, _, _ = handbook(workspace)

    def refuse(_text: str):
        raise AssertionError("keyword search must not need the embedding model")

    monkeypatch.setattr(workspace.embedder, "embed_query", refuse)
    assert _search(workspace, collection_id, "ECONNRESET", mode="keyword")["results"]


def test_rate_limit(make_workspace: Callable[..., Workspace]) -> None:
    workspace = make_workspace(rate_limit_per_minute=2)
    collection_id, _, _ = handbook(workspace)
    payload = {"query": "password", "collection_id": collection_id, "mode": "keyword"}
    assert workspace.post("/api/search", payload).status_code == 200
    assert workspace.post("/api/search", payload).status_code == 200
    limited = workspace.post("/api/search", payload)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"


@pytest.mark.parametrize(
    ("source", "query"),
    [
        ("Straße café", "strasse"),
        ("ＦＵＬＬ－ＷＩＤＴＨ", "full-width"),
        ("Don't erase 1.2.3", "dont 1.2.3"),
        ("don’t retry maxRetries", "dont retry"),
    ],
)
def test_every_matched_term_can_be_highlighted_in_hit_text(
    workspace: Workspace, source: str, query: str
) -> None:
    collection_id = workspace.collection()
    workspace.document(collection_id, "Source spellings", [source])
    hits = _search(workspace, collection_id, query, mode="keyword")["results"]
    assert hits
    for hit in hits:
        assert hit["matched_terms"]
        assert all(term in hit["text"] and term.lower() in hit["text"].lower() for term in hit["matched_terms"])
