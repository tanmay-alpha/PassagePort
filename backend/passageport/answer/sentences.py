"""Sentence splitting that preserves the original text.

Extractive answers and document comparison quote sentences verbatim, so every returned sentence is
an exact substring of the input (only surrounding whitespace is dropped). Single newlines inside
prose are soft wraps, as commonly produced by PDF extraction. Blank lines and Markdown structure
still separate fragments without inventing punctuation or rewriting source text.
"""

from __future__ import annotations

import re
from typing import NamedTuple

# Abbreviations after which a period does not end a sentence.
_ABBREVIATIONS = frozenset(
    [
        "e.g",
        "i.e",
        "etc",
        "vs",
        "cf",
        "fig",
        "figs",
        "eq",
        "eqs",
        "no",
        "nos",
        "vol",
        "approx",
        "dr",
        "mr",
        "mrs",
        "ms",
        "prof",
        "st",
        "sec",
        "al",
        "inc",
        "ltd",
        "co",
    ]
)
# Passage text is attacker-controlled, so every pattern here must run in linear time. The
# lookbehind lets a boundary start only at the first character of a punctuation run; without it a
# long run of "!" not followed by whitespace is rescanned from every position (quadratic).
_BOUNDARY = re.compile(r"""(?<![.!?])[.!?]+["')\]]*(?=\s+\S)""")
_CLOSERS = "\"')]"
_TERMINATORS = ".!?"
_WORD_CHAR = re.compile(r"[\w.]")
_LETTER = re.compile(r"[^\W\d_]")
_SPACE_RUN = re.compile(r"\s*")
_LIST_MARKER = re.compile(r"^(?:[-*+\u2022]|\d{1,3}[.)])\s+")
_STRUCTURAL_LINE = re.compile(r"^\s*(?:#{1,6}(?:\s|$)|(?:[-*+\u2022]|\d{1,3}[.)])\s+|\||```|~~~)")


class Sentence(NamedTuple):
    text: str
    start: int  # offset of ``text`` in the input
    end: int


def _last_word(text: str, start: int, end: int) -> str | None:
    """The word in front of the closing punctuation of ``text[start:end]``, or None.

    Equivalent to ``re.search(r"([^\\W\\d_][\\w.]*)[.!?]+[\\"')\\]]*$", fragment).group(1)`` with
    trailing dots dropped, computed by scanning backwards from the end: a regex search over a long
    run of word characters that is not followed by sentence punctuation backtracks quadratically.
    """
    while end > start and text[end - 1] in _CLOSERS:
        end -= 1
    stop = end
    while stop > start and text[stop - 1] in _TERMINATORS:
        stop -= 1
    if stop == end:
        return None
    first = stop
    while first > start and _WORD_CHAR.match(text, first - 1):
        first -= 1
    letter = _LETTER.search(text, first, stop)
    return None if letter is None else text[letter.start() : stop]


def _ends_with_abbreviation(text: str, start: int, end: int) -> bool:
    word = _last_word(text, start, end)
    if word is None:
        return False
    word = word.lower()
    # A single letter followed by a period is an initial ("J. Smith") or part of "e.g."/"U.S.".
    return word in _ABBREVIATIONS or len(word) == 1 or ("." in word and len(word) <= 4)


def _starts_sentence(text: str, position: int) -> bool:
    """True when the text after a period looks like a new sentence rather than a continuation."""
    following = _SPACE_RUN.match(text, position)
    visible = following.end() if following else position
    return not text[visible : visible + 1].islower()


def split_sentences(text: str) -> list[Sentence]:
    sentences: list[Sentence] = []
    offset = block_start = 0
    for line in text.splitlines(keepends=True):
        if not line.strip() or _STRUCTURAL_LINE.match(line):
            _split_block(sentences, text[block_start:offset], block_start)
            _split_block(sentences, line, offset)
            block_start = offset + len(line)
        offset += len(line)
    _split_block(sentences, text[block_start:], block_start)
    return sentences


def _split_block(sentences: list[Sentence], block: str, offset: int) -> None:
    start = 0
    for match in _BOUNDARY.finditer(block):
        end = match.end()
        if _ends_with_abbreviation(block, start, end) or not _starts_sentence(block, end):
            continue
        _append(sentences, block, start, end, offset)
        start = end
    _append(sentences, block, start, len(block), offset)


def _append(sentences: list[Sentence], line: str, start: int, end: int, offset: int) -> None:
    while start < end and line[start].isspace():
        start += 1
    while end > start and line[end - 1].isspace():
        end -= 1
    if start < end and any(ch.isalnum() for ch in line[start:end]):
        sentences.append(Sentence(line[start:end], offset + start, offset + end))


def strip_list_marker(sentence: str) -> str:
    """``- item`` / ``3. item`` -> ``item``; used when comparing sentences, never when quoting."""
    return _LIST_MARKER.sub("", sentence, count=1)
