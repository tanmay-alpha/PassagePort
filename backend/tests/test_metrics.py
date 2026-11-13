"""Ranking metrics against hand-computed values."""

from __future__ import annotations

import math

import pytest

from passageport.evaluation.metrics import (
    mean,
    ndcg_at_k,
    percentile,
    precision_at_k,
    recall_at_k,
    reciprocal_rank,
)

RANKED = ["d1", "d2", "d3", "d4", "d5"]
RELEVANT = {"d2", "d5", "d9"}  # d9 is never retrieved


def test_recall_at_k() -> None:
    assert recall_at_k(RANKED, RELEVANT, 1) == 0.0
    assert recall_at_k(RANKED, RELEVANT, 2) == pytest.approx(1 / 3)
    assert recall_at_k(RANKED, RELEVANT, 5) == pytest.approx(2 / 3)
    assert recall_at_k(RANKED, RELEVANT, 10) == pytest.approx(2 / 3)


def test_precision_at_k_divides_by_k_even_for_short_rankings() -> None:
    assert precision_at_k(RANKED, RELEVANT, 1) == 0.0
    assert precision_at_k(RANKED, RELEVANT, 2) == 0.5
    assert precision_at_k(RANKED, RELEVANT, 5) == pytest.approx(0.4)
    assert precision_at_k(["d2"], RELEVANT, 5) == pytest.approx(0.2)


def test_reciprocal_rank() -> None:
    assert reciprocal_rank(RANKED, RELEVANT) == 0.5
    assert reciprocal_rank(["d5"], RELEVANT) == 1.0
    assert reciprocal_rank(["d1", "d3"], RELEVANT) == 0.0
    assert reciprocal_rank([], RELEVANT) == 0.0


def test_ndcg_at_k() -> None:
    # Relevant at ranks 2 and 5: DCG = 1/log2(3) + 1/log2(6). Ideal for 3 relevant: ranks 1, 2, 3.
    dcg = 1 / math.log2(3) + 1 / math.log2(6)
    ideal = 1 + 1 / math.log2(3) + 1 / math.log2(4)
    assert ndcg_at_k(RANKED, RELEVANT, 10) == pytest.approx(dcg / ideal)
    assert ndcg_at_k(RANKED, RELEVANT, 10) == pytest.approx(0.4776, abs=1e-4)
    # With k = 2 only rank 2 counts and the ideal list has two relevant items.
    assert ndcg_at_k(RANKED, RELEVANT, 2) == pytest.approx((1 / math.log2(3)) / (1 + 1 / math.log2(3)))
    assert ndcg_at_k(["d2", "d5", "d9"], RELEVANT, 10) == pytest.approx(1.0)
    assert ndcg_at_k(["d1"], RELEVANT, 10) == 0.0


def test_metrics_reject_undefined_input() -> None:
    with pytest.raises(ValueError, match="relevant"):
        recall_at_k(RANKED, set(), 5)
    with pytest.raises(ValueError, match="relevant"):
        ndcg_at_k(RANKED, set(), 5)
    with pytest.raises(ValueError, match="positive"):
        precision_at_k(RANKED, RELEVANT, 0)
    with pytest.raises(ValueError, match="duplicates"):
        recall_at_k(["d1", "d1"], RELEVANT, 5)


def test_percentile_and_mean() -> None:
    values = [10.0, 20.0, 30.0, 40.0]
    assert percentile(values, 50) == pytest.approx(25.0)
    assert percentile(values, 95) == pytest.approx(38.5)
    assert percentile(values, 0) == 10.0
    assert percentile(values, 100) == 40.0
    assert percentile([7.0], 95) == 7.0
    assert mean([1.0, 2.0, 6.0]) == pytest.approx(3.0)
    assert mean([]) == 0.0
    with pytest.raises(ValueError, match="no values"):
        percentile([], 50)
