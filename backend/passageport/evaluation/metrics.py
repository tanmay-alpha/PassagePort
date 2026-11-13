"""Ranking metrics with binary relevance.

Each function takes the ranked ids returned for ONE query and the set of ids judged relevant. The
harness averages them over queries (macro average). Definitions:

* recall@k     relevant ids found in the top k / all relevant ids
* precision@k  relevant ids found in the top k / k   (k is the denominator even if fewer were returned)
* reciprocal rank  1 / rank of the first relevant id, 0 if none was returned
* nDCG@k       DCG@k / ideal DCG@k with gain 1 for a relevant id and log2(rank + 1) discount
"""

from __future__ import annotations

import math
from collections.abc import Collection, Hashable, Sequence


def _check(ranked: Sequence[Hashable], k: int) -> None:
    if k <= 0:
        raise ValueError("k must be positive")
    if len(set(ranked)) != len(ranked):
        raise ValueError("a ranking must not contain duplicates")


def recall_at_k(ranked: Sequence[Hashable], relevant: Collection[Hashable], k: int) -> float:
    _check(ranked, k)
    if not relevant:
        raise ValueError("recall is undefined without relevant items")
    return sum(1 for item in ranked[:k] if item in relevant) / len(relevant)


def precision_at_k(ranked: Sequence[Hashable], relevant: Collection[Hashable], k: int) -> float:
    _check(ranked, k)
    return sum(1 for item in ranked[:k] if item in relevant) / k


def reciprocal_rank(ranked: Sequence[Hashable], relevant: Collection[Hashable]) -> float:
    for position, item in enumerate(ranked, start=1):
        if item in relevant:
            return 1.0 / position
    return 0.0


def ndcg_at_k(ranked: Sequence[Hashable], relevant: Collection[Hashable], k: int) -> float:
    _check(ranked, k)
    if not relevant:
        raise ValueError("nDCG is undefined without relevant items")
    dcg = sum(1.0 / math.log2(position + 1) for position, item in enumerate(ranked[:k], start=1) if item in relevant)
    ideal = sum(1.0 / math.log2(position + 1) for position in range(1, min(len(relevant), k) + 1))
    return dcg / ideal


def percentile(values: Sequence[float], q: float) -> float:
    """Linear-interpolated percentile, ``q`` in 0..100 (same convention as numpy's default)."""
    if not values:
        raise ValueError("no values")
    ordered = sorted(values)
    position = (len(ordered) - 1) * q / 100.0
    lower = math.floor(position)
    upper = math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0
