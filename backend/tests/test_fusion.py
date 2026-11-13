"""Weighted reciprocal-rank fusion, checked against values computed by hand."""

from __future__ import annotations

import pytest

from passageport.search.fusion import weighted_rrf


def test_exact_scores_with_equal_weights() -> None:
    fused = weighted_rrf([["a", "b", "c"], ["b", "c", "d"]], [1.0, 1.0], rrf_k=60)
    assert [item for item, _ in fused] == ["b", "c", "a", "d"]
    scores = dict(fused)
    assert scores["a"] == pytest.approx(1 / 61)
    assert scores["b"] == pytest.approx(1 / 62 + 1 / 61)
    assert scores["c"] == pytest.approx(1 / 63 + 1 / 62)
    assert scores["d"] == pytest.approx(1 / 63)
    assert scores["b"] == pytest.approx(0.032522, abs=1e-6)


def test_weights_scale_each_list() -> None:
    fused = dict(weighted_rrf([["a", "b"], ["b", "a"]], [2.0, 0.5], rrf_k=10))
    assert fused["a"] == pytest.approx(2 / 11 + 0.5 / 12)
    assert fused["b"] == pytest.approx(2 / 12 + 0.5 / 11)
    assert fused["a"] > fused["b"]


def test_small_rrf_k_favours_top_ranks() -> None:
    lists = [["a", "x", "y", "b"], ["b", "p", "q", "r"]]
    # "b" is first in one list and fourth in the other; "x" is second in one list only.
    sharp = dict(weighted_rrf(lists, [1, 1], rrf_k=0))
    assert sharp["b"] == pytest.approx(1 / 4 + 1 / 1)
    assert sharp["x"] == pytest.approx(1 / 2)


def test_zero_weight_list_contributes_nothing() -> None:
    fused = weighted_rrf([["a", "b"], ["c", "a"]], [1.0, 0.0], rrf_k=60)
    assert fused == [("a", pytest.approx(1 / 61)), ("b", pytest.approx(1 / 62))]


def test_ties_are_broken_deterministically() -> None:
    assert [i for i, _ in weighted_rrf([["b"], ["a"]], [1, 1], rrf_k=60)] == ["a", "b"]
    by_reverse = weighted_rrf([["b"], ["a"]], [1, 1], rrf_k=60, tiebreak=lambda item: -ord(item))
    assert [i for i, _ in by_reverse] == ["b", "a"]


def test_empty_and_invalid_input() -> None:
    assert weighted_rrf([[], []], [1, 1], rrf_k=60) == []
    with pytest.raises(ValueError, match="one weight per ranking"):
        weighted_rrf([["a"]], [1, 1], rrf_k=60)
    with pytest.raises(ValueError, match="negative"):
        weighted_rrf([["a"]], [-1], rrf_k=60)
    with pytest.raises(ValueError, match="twice"):
        weighted_rrf([["a", "a"]], [1], rrf_k=60)
