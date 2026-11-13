"""BM25 on a corpus small enough to score by hand."""

from __future__ import annotations

import math

import numpy as np
import pytest

from passageport.search.bm25 import BM25Index

K1, B = 1.2, 0.75
CORPUS = [
    ["apple", "banana"],  # row 0, length 2
    ["apple", "apple", "cherry"],  # row 1, length 3
    ["banana", "cherry", "cherry", "date"],  # row 2, length 4
]  # average length 3


def _idf(df: int, n: int = 3) -> float:
    return math.log(1 + (n - df + 0.5) / (df + 0.5))


def _term(tf: int, length: int, df: int) -> float:
    return _idf(df) * tf * (K1 + 1) / (tf + K1 * (1 - B + B * length / 3))


def test_statistics() -> None:
    index = BM25Index(CORPUS)
    assert index.size == 3
    assert index.average_length == pytest.approx(3.0)
    assert index.vocabulary_size == 4
    assert index.document_frequency("apple") == 2
    assert index.document_frequency("missing") == 0
    assert index.idf("date") == pytest.approx(math.log(1 + 2.5 / 1.5))


def test_single_term_scores_match_the_formula() -> None:
    hits = BM25Index(CORPUS).search(["apple"], k1=K1, b=B, limit=10)
    # Row 1 mentions "apple" twice and wins although it is longer than row 0.
    assert [h.row for h in hits] == [1, 0]
    assert hits[0].score == pytest.approx(_term(2, 3, 2), rel=1e-5)
    assert hits[1].score == pytest.approx(_term(1, 2, 2), rel=1e-5)
    assert hits[0].score == pytest.approx(0.6463, abs=1e-4)
    assert hits[1].score == pytest.approx(0.5442, abs=1e-4)


def test_multi_term_scores_add_up_and_report_matched_terms() -> None:
    hits = BM25Index(CORPUS).search(["banana", "date"], k1=K1, b=B, limit=10)
    assert [h.row for h in hits] == [2, 0]
    assert hits[0].score == pytest.approx(_term(1, 4, 2) + _term(1, 4, 1), rel=1e-5)
    assert hits[0].terms == ("banana", "date")
    assert hits[1].terms == ("banana",)


def test_rare_terms_weigh_more_than_common_ones() -> None:
    index = BM25Index(CORPUS)
    assert index.idf("date") > index.idf("apple")
    # A term that occurs in every row still has a positive (Lucene-style) idf.
    everywhere = BM25Index([["x", "a"], ["x", "b"], ["x", "c"]])
    assert everywhere.idf("x") > 0
    assert all(h.score > 0 for h in everywhere.search(["x"], k1=K1, b=B, limit=3))


def test_repeated_query_terms_count_once() -> None:
    index = BM25Index(CORPUS)
    once = index.search(["apple"], k1=K1, b=B, limit=10)
    twice = index.search(["apple", "apple"], k1=K1, b=B, limit=10)
    assert [(h.row, h.score) for h in once] == [(h.row, h.score) for h in twice]


def test_no_match_and_empty_index() -> None:
    assert BM25Index(CORPUS).search(["zebra"], k1=K1, b=B, limit=10) == []
    assert BM25Index(CORPUS).search([], k1=K1, b=B, limit=10) == []
    assert BM25Index([]).search(["apple"], k1=K1, b=B, limit=10) == []


def test_limit_and_mask() -> None:
    index = BM25Index(CORPUS)
    assert [h.row for h in index.search(["cherry"], k1=K1, b=B, limit=1)] == [2]
    mask = np.array([True, True, False])
    hits = index.search(["cherry"], k1=K1, b=B, limit=10, mask=mask)
    assert [h.row for h in hits] == [1]
    # Filtering does not change collection statistics: the score is the unfiltered one.
    assert hits[0].score == pytest.approx(_term(1, 3, 2), rel=1e-5)


def test_ties_follow_the_tiebreak_rank() -> None:
    index = BM25Index([["same", "text"], ["same", "text"], ["same", "text"]])
    assert [h.row for h in index.search(["same"], k1=K1, b=B, limit=3)] == [0, 1, 2]
    order = np.array([2, 0, 1])  # row 1 has the smallest chunk id, then row 2, then row 0
    assert [h.row for h in index.search(["same"], k1=K1, b=B, limit=3, tiebreak=order)] == [1, 2, 0]


def test_b_zero_ignores_length_and_k1_zero_ignores_frequency() -> None:
    index = BM25Index(CORPUS)
    flat = index.search(["apple"], k1=0.0, b=B, limit=10)
    assert flat[0].score == pytest.approx(flat[1].score)
    no_length = index.scores(["banana"], k1=K1, b=0.0)
    assert no_length[0] == pytest.approx(no_length[2])


def test_coverage_is_the_idf_weighted_share_of_query_terms() -> None:
    index = BM25Index(CORPUS)
    assert index.coverage(["apple", "banana"], [0, 1]) == pytest.approx([1.0, 0.5])
    weights = {"apple": index.idf("apple"), "date": index.idf("date")}
    assert index.coverage(["apple", "date"], [2])[0] == pytest.approx(weights["date"] / sum(weights.values()))
    # A term the collection has never seen keeps a query from looking fully covered.
    assert index.coverage(["apple", "zebra"], [0])[0] < 1.0
    assert index.coverage([], [0]) == [0.0]
