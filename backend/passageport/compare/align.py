"""Pure functions behind document comparison: no database, no models, no I/O.

Two steps, both deterministic:

``match_passages``  groups passages of *different* documents that discuss the same thing, using
                    the cosine similarity of their stored embeddings.
``diff_passages``   compares the text of one group sentence by sentence and reports what is
                    shared, what only one document says, and which values differ.

Everything ``diff_passages`` returns is computed from the text itself. It makes no judgement about
meaning: two differently worded sentences are simply reported as unique to their documents.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from itertools import combinations

import numpy as np

from passageport.answer.sentences import split_sentences, strip_list_marker

# Sentences count as counterparts when, with their values masked, they are at least this similar
# (difflib ratio over characters): the same sentence up to small edits.
SENTENCE_MATCH_RATIO = 0.9
VALUE_PLACEHOLDER = "___"


# --------------------------------------------------------------------------- passage alignment


@dataclass(frozen=True, slots=True)
class AlignItem:
    ref: int
    document_id: str
    vector: np.ndarray  # L2-normalized


@dataclass(frozen=True, slots=True)
class PassageGroup:
    refs: tuple[int, ...]  # one passage per document, in ascending ref order
    similarity: float  # mean pairwise cosine similarity within the group


def match_passages(items: Sequence[AlignItem], threshold: float) -> tuple[list[PassageGroup], list[int]]:
    """Greedy complete-linkage matching.

    Cross-document pairs are visited from most to least similar. A pair merges the groups of its
    two passages only if the merged group would still hold at most one passage per document and
    *every* pair inside it is at least ``threshold`` similar, so a group never chains together
    passages that are only indirectly related. Returns the groups (two or more passages, most
    similar first) and the refs left without a counterpart.
    """
    count = len(items)
    similarity = np.zeros((count, count), dtype=np.float64)
    for a, b in combinations(range(count), 2):
        similarity[a, b] = similarity[b, a] = float(np.dot(items[a].vector, items[b].vector))

    pairs = [
        (a, b)
        for a, b in combinations(range(count), 2)
        if items[a].document_id != items[b].document_id and similarity[a, b] >= threshold
    ]
    pairs.sort(key=lambda p: (-similarity[p[0], p[1]], items[p[0]].ref, items[p[1]].ref))

    group_of: dict[int, list[int]] = {i: [i] for i in range(count)}
    for a, b in pairs:
        left, right = group_of[a], group_of[b]
        if left is right:
            continue
        if {items[i].document_id for i in left} & {items[i].document_id for i in right}:
            continue
        if any(similarity[x, y] < threshold for x in left for y in right):
            continue
        left.extend(right)
        for member in right:
            group_of[member] = left

    groups: list[PassageGroup] = []
    unaligned: list[int] = []
    seen: set[int] = set()
    for i in range(count):
        members = group_of[i]
        if id(members) in seen:
            continue
        seen.add(id(members))
        if len(members) == 1:
            unaligned.append(items[i].ref)
            continue
        scores = [similarity[x, y] for x, y in combinations(members, 2)]
        groups.append(PassageGroup(tuple(sorted(items[m].ref for m in members)), float(np.mean(scores))))
    groups.sort(key=lambda g: (-g.similarity, g.refs))
    return groups, sorted(unaligned)


# --------------------------------------------------------------------------- sentence diff


@dataclass(frozen=True, slots=True)
class ValueDifference:
    context: str  # the sentence of the first document with the differing value replaced by ___
    values: dict[str, str]  # document_id -> value as written


@dataclass(frozen=True, slots=True)
class PassageDiff:
    shared_sentences: list[str]
    unique_sentences: dict[str, list[str]]
    numeric_differences: list[ValueDifference]
    identical: bool


_WORD = re.compile(r"\S+")
_EDGE_PUNCTUATION = "\"'`()[]{}<>,;:!?*"
_PLAIN_NUMBER = re.compile(r"[$\u20ac\u00a3~]?\d[\d.,]*")
_UNITS = frozenset(
    [
        "%",
        "percent",
        "ms",
        "s",
        "sec",
        "secs",
        "second",
        "seconds",
        "millisecond",
        "milliseconds",
        "microsecond",
        "microseconds",
        "min",
        "mins",
        "minute",
        "minutes",
        "hour",
        "hours",
        "day",
        "days",
        "week",
        "weeks",
        "month",
        "months",
        "year",
        "years",
        "byte",
        "bytes",
        "kb",
        "mb",
        "gb",
        "tb",
        "kib",
        "mib",
        "gib",
        "kilobytes",
        "megabytes",
        "gigabytes",
        "terabytes",
        "hz",
        "khz",
        "mhz",
        "ghz",
    ]
)
# Words whose presence changes what a sentence asserts; near-identical sentences that differ in
# them are not reported as shared.
_POLARITY = frozenset(
    [
        "no",
        "not",
        "never",
        "none",
        "cannot",
        "cant",
        "wont",
        "dont",
        "doesnt",
        "isnt",
        "arent",
        "wasnt",
        "werent",
        "hasnt",
        "havent",
        "hadnt",
        "didnt",
        "couldnt",
        "wouldnt",
        "shouldnt",
        "mustnt",
        "neednt",
        "mightnt",
        "shant",
        "aint",
        "oughtnt",
        "darent",
        "without",
        "unless",
        "except",
        "only",
        "must",
        "may",
        "should",
        "shall",
        "always",
        "optional",
        "required",
        "mandatory",
        "forbidden",
        "allowed",
    ]
)


@dataclass(frozen=True, slots=True)
class _Sentence:
    text: str  # verbatim
    display: str  # verbatim without a leading list marker
    masked: str  # normalized, every value replaced by "#"
    values: tuple[tuple[int, int, str], ...]  # (start, end, text) spans within ``display``
    polarity: tuple[str, ...]


def _core(word: str, start: int) -> tuple[int, int, str]:
    """Strip quoting/punctuation around a word; a trailing period goes unless it is "1.5"-internal."""
    left = len(word) - len(word.lstrip(_EDGE_PUNCTUATION))
    stripped = word[left:].rstrip(_EDGE_PUNCTUATION + ".")
    return start + left, start + left + len(stripped), stripped


def _is_value(core: str) -> bool:
    """Numbers, versions and identifiers: tokens where a one-character change changes the meaning."""
    if not core:
        return False
    if any(ch.isdigit() for ch in core) or "_" in core:
        return True
    if "/" in core and any(ch.isalnum() for ch in core):
        return True
    letters = [ch for ch in core if ch.isalpha()]
    return len(letters) >= 2 and all(ch.isupper() for ch in letters)


def _analyse(text: str) -> _Sentence:
    display = strip_list_marker(text.strip())
    words = [_core(m.group(), m.start()) for m in _WORD.finditer(display)]
    values: list[tuple[int, int, str]] = []
    skip = False
    for i, (start, word_end, core) in enumerate(words):
        if skip:
            skip = False
            continue
        if not _is_value(core):
            continue
        end = word_end
        if _PLAIN_NUMBER.fullmatch(core) and i + 1 < len(words) and words[i + 1][2].casefold() in _UNITS:
            end = words[i + 1][1]  # "30 minutes" is one value
            skip = True
        values.append((start, end, display[start:end]))
    pieces: list[str] = []
    cursor = 0
    for start, end, _ in values:
        pieces.append(display[cursor:start])
        pieces.append("#")
        cursor = end
    pieces.append(display[cursor:])
    masked = " ".join("".join(pieces).casefold().split())
    plain = re.sub(r"['\u2019]", "", masked)
    polarity = tuple(sorted(w for w in re.findall(r"[a-z]+", plain) if w in _POLARITY))
    return _Sentence(text.strip(), display, masked, tuple(values), polarity)


def _counterpart(sentence: _Sentence, pool: Sequence[_Sentence], used: set[int]) -> int | None:
    """Index of the unused sentence in ``pool`` most similar to ``sentence``, if similar enough."""
    best: tuple[float, int] | None = None
    for i, other in enumerate(pool):
        if i in used:
            continue
        if other.masked == sentence.masked:
            return i
        matcher = SequenceMatcher(None, sentence.masked, other.masked, autojunk=False)
        if matcher.real_quick_ratio() < SENTENCE_MATCH_RATIO or matcher.quick_ratio() < SENTENCE_MATCH_RATIO:
            continue
        ratio = matcher.ratio()
        if ratio >= SENTENCE_MATCH_RATIO and (best is None or ratio > best[0]):
            best = (ratio, i)
    return None if best is None else best[1]


def _same_values(group: Sequence[_Sentence]) -> bool:
    first = [v.casefold() for _, _, v in group[0].values]
    return all([v.casefold() for _, _, v in s.values] == first for s in group[1:])


def diff_passages(texts: Mapping[str, str]) -> PassageDiff:
    """Compare aligned passages (``document_id -> text``, two or more) sentence by sentence.

    * shared: the sentence has a counterpart in every passage (equal after normalizing case,
      whitespace and list markers, or difflib ratio >= 0.9) with the same values and the same
      polarity words. Reported as written in the first document.
    * numeric difference: counterparts in every passage whose numbers, units, versions or
      identifiers differ. One entry per differing value.
    * unique: everything else, per document, in reading order.
    """
    document_ids = list(texts)
    if len(document_ids) < 2:
        raise ValueError("at least two passages are required")
    sentences = {doc: [_analyse(s.text) for s in split_sentences(texts[doc])] for doc in document_ids}
    anchor_id, others = document_ids[0], document_ids[1:]
    used: dict[str, set[int]] = {doc: set() for doc in document_ids}
    shared: list[str] = []
    differences: list[ValueDifference] = []

    for position, sentence in enumerate(sentences[anchor_id]):
        matches: dict[str, int] = {}
        for doc in others:
            found = _counterpart(sentence, sentences[doc], used[doc])
            if found is None:
                break
            matches[doc] = found
        if len(matches) != len(others):
            continue
        group = [sentence] + [sentences[doc][matches[doc]] for doc in others]
        if any(s.polarity != sentence.polarity for s in group) or len({len(s.values) for s in group}) != 1:
            continue  # counterparts in form, but not safely comparable: left as unique
        used[anchor_id].add(position)
        for doc in others:
            used[doc].add(matches[doc])
        if _same_values(group):
            shared.append(sentence.text)
            continue
        for slot, (start, end, written) in enumerate(sentence.values):
            per_document = {anchor_id: written}
            for doc, other in zip(others, group[1:], strict=True):
                per_document[doc] = other.values[slot][2]
            if len({v.casefold() for v in per_document.values()}) > 1:
                context = sentence.display[:start] + VALUE_PLACEHOLDER + sentence.display[end:]
                differences.append(ValueDifference(context, per_document))

    unique = {
        doc: [s.text for i, s in enumerate(sentences[doc]) if i not in used[doc]] for doc in document_ids
    }
    normalized = [
        " ".join(" ".join(s.display.casefold().split()) for s in sentences[doc]) for doc in document_ids
    ]
    identical = all(n == normalized[0] for n in normalized[1:]) and bool(normalized[0])
    return PassageDiff(shared, unique, differences, identical)
