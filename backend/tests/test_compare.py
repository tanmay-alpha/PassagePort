"""Real comparison response models, evidence isolation and computed differences."""

from __future__ import annotations

from collections.abc import Callable

from retrieval_helpers import BOB, ConceptEmbedder, Workspace

from passageport.api.schemas import CompareOut

pytest_plugins = ["retrieval_helpers"]


def _versions(workspace: Workspace) -> tuple[str, str]:
    collection = workspace.collection()
    left = workspace.document(collection, "Policy 1", ["The password reset link expires after 30 minutes."])
    right = workspace.document(collection, "Policy 2", ["The password reset link expires after 45 minutes."])
    return left, right


def test_compare_returns_real_numeric_differences(make_workspace: Callable[..., Workspace]) -> None:
    workspace = make_workspace(embedder=ConceptEmbedder())
    left, right = _versions(workspace)
    body = workspace.ok("/api/compare", {"question": "password reset link", "document_ids": [left, right]})
    result = CompareOut.model_validate(body)
    assert all(document.has_evidence for document in result.documents)
    assert len(result.alignments) == 1
    difference = result.alignments[0].numeric_differences[0]
    assert difference.values == {left: "30 minutes", right: "45 minutes"}
    assert result.alignments[0].shared_sentences == []
    assert result.interpretation is None
    refs = [e.ref for document in result.documents for e in document.evidence]
    assert refs == [1, 2]
    assert {passage.ref for passage in result.alignments[0].passages} == set(refs)


def test_compare_does_not_share_contradictory_contractions(make_workspace: Callable[..., Workspace]) -> None:
    workspace = make_workspace(embedder=ConceptEmbedder())
    collection = workspace.collection()
    prefix = "The password reset link used for recovery in the production account "
    left = workspace.document(
        collection, "Negative", [prefix + "doesn’t expire after the recovery operation."]
    )
    right = workspace.document(collection, "Positive", [prefix + "does expire after the recovery operation."])
    body = workspace.ok("/api/compare", {"question": "password reset link", "document_ids": [left, right]})
    assert body["alignments"]
    assert body["alignments"][0]["shared_sentences"] == []
    assert all(body["alignments"][0]["unique_sentences"].values())


def test_compare_validates_interpretation_citations(make_workspace: Callable[..., Workspace]) -> None:
    workspace = make_workspace(embedder=ConceptEmbedder())
    left, right = _versions(workspace)
    workspace.use_llm("The password reset link durations differ [1][2][99].")
    result = workspace.ok("/api/compare", {"question": "password reset", "document_ids": [left, right]})
    assert result["interpretation"][0]["citations"] == [1, 2]
    assert result["interpretation"][0]["supported"] is True
    assert "not independently fact-checked" in result["notice"]


def test_compare_rejects_other_users_documents(workspace: Workspace) -> None:
    left, right = _versions(workspace)
    workspace.act_as(BOB)
    response = workspace.post("/api/compare", {"question": "password reset", "document_ids": [left, right]})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_compare_reports_absent_evidence_without_calling_llm(
    make_workspace: Callable[..., Workspace],
) -> None:
    workspace = make_workspace(embedder=ConceptEmbedder())
    left, right = _versions(workspace)
    fake = workspace.use_llm("An invented answer [1].")
    result = workspace.ok(
        "/api/compare", {"question": "quantum chromodynamics", "document_ids": [left, right]}
    )
    assert all(not document["has_evidence"] for document in result["documents"])
    assert result["alignments"] == []
    assert result["interpretation"] is None
    assert fake.calls == []
    assert "None of the selected documents" in result["notice"]
