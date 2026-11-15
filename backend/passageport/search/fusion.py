"""Weighted reciprocal-rank fusion (RRF).

Keyword scores (BM25, unbounded) and semantic scores (cosine, 0..1) live on different scales, so
they are never added. Only the *rank* of an item in each list is used:

    score(d) = sum over lists i of  w_i / (rrf_k + rank_i(d))        rank is 1-based

``rrf_k`` damps the advantage of the very first ranks (Cormack et al. 2009 use 60); the weights let
one retriever count for more than the other.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable, Sequence
from typing import Any


def weighted_rrf[T: Hashable](
    rankings: Sequence[Sequence[T]],
    weights: Sequence[float],
    rrf_k: int,
    tiebreak: Callable[[T], Any] | None = None,
) -> list[tuple[T, float]]:
    """Fuse ranked lists of ids into one list of ``(id, score)``, best first.

    Items that receive no score (every list they appear in has weight 0) are left out. Ties are
    ordered by ``tiebreak(id)`` (default: the id itself), which makes the output deterministic.
    """
    if len(rankings) != len(weights):
        raise ValueError("one weight per ranking is required")
    if rrf_k < 0 or any(w < 0 for w in weights):
        raise ValueError("rrf_k and weights must not be negative")
    totals: dict[T, float] = {}
    for ranking, weight in zip(rankings, weights, strict=True):
        if weight == 0:
            continue
        seen: set[T] = set()
        for position, item in enumerate(ranking, start=1):
            if item in seen:
                raise ValueError("a ranking must not contain the same item twice")
            seen.add(item)
            totals[item] = totals.get(item, 0.0) + weight / (rrf_k + position)
    key = tiebreak or (lambda item: item)
    return sorted(totals.items(), key=lambda pair: (-pair[1], key(pair[0])))
