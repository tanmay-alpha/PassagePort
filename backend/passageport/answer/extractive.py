"""Extractive answers: the best verbatim sentences of the retrieved passages.

Used when no language model is configured (and as the fallback when one fails). Nothing is
generated: every answer sentence is an exact substring of the passage it cites.

Each candidate sentence is scored against the question with

    0.6 * cosine(sentence, question)  +  0.3 * share of question terms in the sentence
    + 0.1 / rank of its passage

so meaning counts most, literal overlap rewards sentences that mention what was asked about, and a
small prior prefers the passages retrieval already ranked higher.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher

import numpy as np

from passageport.answer.sentences import split_sentences, strip_list_marker
from passageport.api.schemas import AnswerSegment
from passageport.ml.protocols import Embedder
from passageport.search.tokenize import query_terms, tokenize

MAX_SENTENCES = 4
MIN_SENTENCES = 2
MAX_PASSAGES = 4  # only the top passages are mined for sentences
# A sentence is kept beyond the minimum only if it scores close to the best one.
RELATIVE_SCORE_FLOOR = 0.8
DUPLICATE_RATIO = 0.9
_MIN_WORDS = 4
_MAX_CHARS = 600


@dataclass(frozen=True, slots=True)
class _Scored:
    ref: int
    position: int
    text: str
    score: float


def _is_prose(sentence: str) -> bool:
    """Skip headings, table rows and fragments: they do not read as an answer."""
    stripped = sentence.lstrip()
    if stripped.startswith(("#", "|", "```")) or len(sentence) > _MAX_CHARS:
        return False
    return len(strip_list_marker(stripped).split()) >= _MIN_WORDS


def _normalized(sentence: str) -> str:
    return " ".join(strip_list_marker(sentence).casefold().split())


def _is_duplicate(sentence: str, chosen: Sequence[str]) -> bool:
    return any(
        sentence == other or SequenceMatcher(None, sentence, other, autojunk=False).ratio() >= DUPLICATE_RATIO
        for other in chosen
    )


def select_sentences(
    question: str, passages: Sequence[tuple[int, str]], embedder: Embedder
) -> list[AnswerSegment]:
    """Pick 2-4 sentences from ``passages`` (``(ref, text)``, best first), in reading order.

    Returns fewer when the passages hold fewer usable sentences, and falls back to the first
    sentence of the top passage rather than returning nothing when evidence exists.
    """
    candidates: list[tuple[int, int, str]] = []
    for ref, text in passages[:MAX_PASSAGES]:
        for position, sentence in enumerate(split_sentences(text)):
            if _is_prose(sentence.text):
                candidates.append((ref, position, sentence.text))
    if not candidates:
        for ref, text in passages[:1]:
            first = split_sentences(text)
            if first:
                return [AnswerSegment(text=first[0].text, citations=[ref], supported=True)]
        return []

    question_vector = embedder.embed_query(question)
    similarities = embedder.embed_documents([text for _, _, text in candidates]) @ question_vector
    terms = set(query_terms(question))
    rank_of = {ref: rank for rank, (ref, _) in enumerate(passages, start=1)}
    scored: list[_Scored] = []
    for (ref, position, text), similarity in zip(
        candidates, np.asarray(similarities, dtype=float), strict=True
    ):
        overlap = len(terms & set(tokenize(text))) / len(terms) if terms else 0.0
        scored.append(
            _Scored(ref, position, text, 0.6 * float(similarity) + 0.3 * overlap + 0.1 / rank_of[ref])
        )
    scored.sort(key=lambda s: (-s.score, s.ref, s.position))

    best = scored[0].score
    chosen: list[_Scored] = []
    normalized: list[str] = []
    for item in scored:
        if len(chosen) >= MAX_SENTENCES:
            break
        if len(chosen) >= MIN_SENTENCES and item.score < RELATIVE_SCORE_FLOOR * best:
            break
        key = _normalized(item.text)
        if _is_duplicate(key, normalized):
            continue
        chosen.append(item)
        normalized.append(key)

    chosen.sort(key=lambda s: (s.ref, s.position))
    return [AnswerSegment(text=s.text, citations=[s.ref], supported=True) for s in chosen]
