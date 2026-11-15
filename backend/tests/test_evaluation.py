"""Evaluation artifacts remain compatible with the actual Search Lab API."""

from __future__ import annotations

from pathlib import Path

from retrieval_helpers import Workspace

from passageport.api.schemas import EvalReport
from passageport.evaluation.baseline import _relevant, _spans, _summary
from passageport.evaluation.datasets import EvalCorpus, EvalDocument, EvalQuery, Quote
from passageport.evaluation.run import _balanced

pytest_plugins = ["retrieval_helpers"]


def test_committed_report_is_served_through_the_api(workspace: Workspace) -> None:
    response = workspace.client.get("/api/lab/evaluation")
    assert response.status_code == 200
    report = EvalReport.model_validate(response.json())
    assert report.datasets
    assert all(dataset.runs and dataset.documents > 0 for dataset in report.datasets)


def test_missing_configured_report_returns_controlled_404(workspace: Workspace, tmp_path: Path) -> None:
    workspace.settings.eval_report_path = tmp_path / "absent.json"
    response = workspace.client.get("/api/lab/evaluation")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_upstream_quote_overlap_matches_improved_relevance_rule() -> None:
    corpus = EvalCorpus(
        "sample", "sample", "chunk", (EvalDocument("doc", "doc", "txt", b"prefix answer suffix"),), ()
    )
    query = EvalQuery("q", "answer", "exact", frozenset({"doc"}), (Quote("doc", "answer"),))
    rows = [
        {"chunk_id": "left", "source_document": "doc", "chunk_offset": 0, "content": "prefix "},
        {"chunk_id": "overlap", "source_document": "doc", "chunk_offset": 7, "content": "ans"},
        {"chunk_id": "right", "source_document": "doc", "chunk_offset": 13, "content": " suffix"},
    ]
    source = {"doc": "prefix answer suffix"}
    assert _relevant(query, corpus, rows, _spans(rows, source)) == frozenset({"overlap"})


def test_upstream_relevance_survives_wrong_offsets_and_row_order() -> None:
    # Upstream's stored chunk_offset can drift and LanceDB returns rows in no promised order;
    # relevance must come from where the chunk text really is.
    text = "alpha beta. gamma delta answer here. epsilon zeta."
    corpus = EvalCorpus("sample", "sample", "chunk", (EvalDocument("doc", "doc", "txt", text.encode()),), ())
    query = EvalQuery("q", "answer", "exact", frozenset({"doc"}), (Quote("doc", "answer here"),))
    rows = [
        {"chunk_id": "last", "source_document": "doc", "chunk_offset": 0, "content": "epsilon zeta."},
        {
            "chunk_id": "middle",
            "source_document": "doc",
            "chunk_offset": 0,
            "content": "gamma delta answer here.",
        },
        {"chunk_id": "first", "source_document": "doc", "chunk_offset": 0, "content": "alpha beta."},
    ]
    assert _relevant(query, corpus, rows, _spans(rows, {"doc": text})) == frozenset({"middle"})


def test_upstream_summary_never_invents_a_confidence_gate() -> None:
    result = _summary(
        [
            (["answer", "other"], frozenset({"answer"}), 10.0, True),
            (["other"], frozenset(), 20.0, False),
        ]
    )
    assert result["recall_at_k"]["1"] == 1.0
    assert result["mrr"] == 1.0
    assert result["queries"] == 1
    assert result["latency_ms_p50"] == 15.0
    assert result["confidence_supported"] is False
    assert result["out_of_scope_returned_results"] == 1


def test_calibration_balances_groups_not_sample_counts() -> None:
    rates = {"mini: answerable": 0.8, "mini: out-of-scope": 0.0, "mini: source removed": 0.4}
    assert _balanced(rates, {"mini: answerable"}) == 0.8
