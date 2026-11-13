"""Sentence splitting that preserves the original text.

Extractive answers and document comparison quote sentences verbatim, so every returned sentence is
an exact substring of the input (only surrounding whitespace is dropped). A line break always ends
a sentence: in Markdown and plain text, headings, list items and table rows are separate lines.
"""

from __future__ import annotations

import re
from typing import NamedTuple

# Abbreviations after which a period does not end a sentence.
_ABBREVIATIONS = frozenset(
    "e.g i.e etc vs cf fig figs eq eqs no nos vol approx dr mr mrs ms prof st sec al inc ltd co".split()
)
_BOUNDARY = re.compile(r"""[.!?]+["')\]]*(?=\s+\S)""")
_LAST_WORD = re.compile(r"([^\W\d_][\w.]*)[.!?]+[\"')\]]*$")
_LIST_MARKER = re.compile(r"^(?:[-*+\u2022]|\d{1,3}[.)])\s+")


class Sentence(NamedTuple):
    text: str
    start: int  # offset of ``text`` in the input
    end: int


def _ends_with_abbreviation(fragment: str) -> bool:
    match = _LAST_WORD.search(fragment)
    if not match:
        return False
    word = match.group(1).rstrip(".").lower()
    # A single letter followed by a period is an initial ("J. Smith") or part of "e.g."/"U.S.".
    return word in _ABBREVIATIONS or len(word) == 1 or "." in word and len(word) <= 4


def _starts_sentence(text: str, position: int) -> bool:
    """True when the text after a period looks like a new sentence rather than a continuation."""
    rest = text[position:].lstrip()
    return not rest[:1].islower()


def split_sentences(text: str) -> list[Sentence]:
    sentences: list[Sentence] = []
    offset = 0
    for line in text.split("\n"):
        start = 0
        for match in _BOUNDARY.finditer(line):
            end = match.end()
            if _ends_with_abbreviation(line[start:end]) or not _starts_sentence(line, end):
                continue
            _append(sentences, line, start, end, offset)
            start = end
        _append(sentences, line, start, len(line), offset)
        offset += len(line) + 1
    return sentences


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
