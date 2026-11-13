"""BM25 over the chunks of one collection.

Postings are numpy arrays (row ids + term frequencies), so scoring a query is a handful of
vectorized additions into one score array. ``k1`` and ``b`` are applied at query time, which keeps
the cached index independent of settings that the Search Lab may override per request.

Scoring (Lucene's non-negative idf, classic saturation):

    idf(t)       = ln(1 + (N - df_t + 0.5) / (df_t + 0.5))
    score(q, d)  = sum over t in q of  idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * |d| / avgdl))
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True, slots=True)
class KeywordHit:
    row: int
    score: float
    terms: tuple[str, ...]  # query terms present in this row


class BM25Index:
    def __init__(self, documents: Sequence[Sequence[str]]) -> None:
        """``documents``: one token list per row, as produced by ``search.tokenize.tokenize``."""
        self.size = len(documents)
        lengths = np.fromiter((len(d) for d in documents), dtype=np.float32, count=self.size)
        self._lengths = lengths
        self.average_length = float(lengths.mean()) if self.size else 0.0

        rows_by_term: dict[str, list[int]] = {}
        freqs_by_term: dict[str, list[int]] = {}
        for row, terms in enumerate(documents):
            for term, freq in Counter(terms).items():
                rows_by_term.setdefault(term, []).append(row)
                freqs_by_term.setdefault(term, []).append(freq)
        # Rows are appended in increasing order, so every posting list is sorted by row.
        self._postings: dict[str, tuple[np.ndarray, np.ndarray]] = {
            term: (np.asarray(rows, dtype=np.int32), np.asarray(freqs_by_term[term], dtype=np.float32))
            for term, rows in rows_by_term.items()
        }

    @property
    def vocabulary_size(self) -> int:
        return len(self._postings)

    def document_frequency(self, term: str) -> int:
        posting = self._postings.get(term)
        return 0 if posting is None else len(posting[0])

    def idf(self, term: str) -> float:
        df = self.document_frequency(term)
        return math.log(1.0 + (self.size - df + 0.5) / (df + 0.5))

    def scores(self, terms: Sequence[str], k1: float, b: float) -> np.ndarray:
        """BM25 score of every row for the distinct ``terms``; 0 where nothing matches."""
        out = np.zeros(self.size, dtype=np.float32)
        if not self.size or self.average_length == 0:
            return out
        norm = k1 * (1.0 - b + b * self._lengths / self.average_length)
        for term in dict.fromkeys(terms):
            posting = self._postings.get(term)
            if posting is None:
                continue
            rows, freqs = posting
            out[rows] += self.idf(term) * freqs * (k1 + 1.0) / (freqs + norm[rows])
        return out

    def search(
        self,
        terms: Sequence[str],
        *,
        k1: float,
        b: float,
        limit: int,
        mask: np.ndarray | None = None,
        tiebreak: np.ndarray | None = None,
    ) -> list[KeywordHit]:
        """Top ``limit`` rows with a positive score, best first.

        ``mask`` (bool per row) restricts the search; collection-wide statistics are still used, so
        a document filter never changes how rare a term is considered. Equal scores are ordered by
        ``tiebreak`` (an integer rank per row), falling back to the row number.
        """
        scores = self.scores(terms, k1, b)
        if mask is not None:
            scores = np.where(mask, scores, 0.0)
        candidates = np.flatnonzero(scores > 0)
        if not len(candidates) or limit <= 0:
            return []
        secondary = candidates if tiebreak is None else tiebreak[candidates]
        order = np.lexsort((secondary, -scores[candidates]))[:limit]
        top = candidates[order]
        present = self._present(list(dict.fromkeys(terms)), top)
        return [KeywordHit(int(row), float(scores[row]), present[i]) for i, row in enumerate(top)]

    def coverage(self, terms: Sequence[str], rows: Sequence[int]) -> list[float]:
        """For each row, the idf-weighted share of the distinct query ``terms`` it contains (0..1).

        Terms unknown to the whole collection still count in the denominator: a query about
        something the collection never mentions must not look fully covered.
        """
        distinct = list(dict.fromkeys(terms))
        if not distinct or not len(rows):
            return [0.0] * len(rows)
        weights = {term: self.idf(term) for term in distinct}
        total = sum(weights.values())
        present = self._present(distinct, np.asarray(rows, dtype=np.int32))
        return [sum(weights[t] for t in found) / total if total else 0.0 for found in present]

    def _present(self, terms: list[str], rows: np.ndarray) -> list[tuple[str, ...]]:
        found: list[list[str]] = [[] for _ in range(len(rows))]
        for term in terms:
            posting = self._postings.get(term)
            if posting is None:
                continue
            term_rows = posting[0]
            positions = np.searchsorted(term_rows, rows)
            positions[positions == len(term_rows)] = 0
            for i in np.flatnonzero(term_rows[positions] == rows):
                found[int(i)].append(term)
        return [tuple(f) for f in found]
