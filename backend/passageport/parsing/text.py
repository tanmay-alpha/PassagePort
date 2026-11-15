"""Deterministic text normalisation and section splitting.

Citations store character offsets into the page text produced here, so every function in this
module must be a pure function of its input: the same bytes always give the same text. Inputs are
attacker-controlled, so every pattern below is linear-time (no nested or lazy quantifiers).
"""

from __future__ import annotations

import re
import unicodedata

SECTION_TARGET_CHARS = 3000
MAX_LABEL_CHARS = 200

_LIGATURES = str.maketrans({"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"})
_LINE_BREAKS = re.compile(r"\r\n|[\r\x0b\x0c\x85\u2028\u2029]")
# Control characters, lone surrogates (not encodable as UTF-8), BOM / zero-width and soft hyphens.
_REMOVED = re.compile(r"[\x00-\x08\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufeff\u200b\u00ad\ufffe\uffff]")
_UNICODE_SPACES = re.compile(r"[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]")
_SPACE_RUN = re.compile(r"[ \t]+")
# "infor-\nmation" -> "information". Only between lowercase letters, so list items, ranges
# ("10-\n20") and capitalised compounds are left alone.
_HYPHEN_BREAK = re.compile(r"(?<=[a-z]{2})-\n(?=[a-z]{2})")
_BLANK_RUN = re.compile(r"\n{3,}")

_MD_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_MD_HEADING = re.compile(r"^ {0,3}#{1,2}[ \t]+(.*)$")


def normalize_text(raw: str, *, reflow: bool) -> str:
    """Clean extracted text.

    ``reflow=True`` (PDF, DOCX) collapses runs of spaces and repairs hyphenated line breaks: the
    spacing there is an artefact of layout extraction. ``reflow=False`` (TXT, Markdown) keeps
    indentation and inner spacing because they carry meaning (code blocks, tables, lists).
    Paragraph breaks (blank lines) are always kept, and never more than one in a row.
    """
    text = unicodedata.normalize("NFC", raw).translate(_LIGATURES)
    text = _LINE_BREAKS.sub("\n", text)
    text = _REMOVED.sub("", text)
    text = _UNICODE_SPACES.sub(" ", text)
    if reflow:
        text = _SPACE_RUN.sub(" ", text)
        text = "\n".join(line.strip(" ") for line in text.split("\n"))
        text = _HYPHEN_BREAK.sub("", text)
    else:
        text = "\n".join(line.rstrip(" \t") for line in text.split("\n"))
    return _BLANK_RUN.sub("\n\n", text).strip("\n")


def clean_label(label: str, fallback: str) -> str:
    """A single-line label that fits the ``pages.label`` column."""
    flat = " ".join(_REMOVED.sub("", label).split())
    return flat[:MAX_LABEL_CHARS].rstrip() or fallback


def _line_units(line: str, separator: str, target: int) -> list[tuple[str, str]]:
    """One line as (separator, piece) units; a line longer than ``2 * target`` is cut at a space
    near ``target`` (or mid-word when it has none)."""
    units: list[tuple[str, str]] = []
    start = 0
    while len(line) - start > 2 * target:
        cut = line.rfind(" ", start + target // 2, start + target)
        if cut == -1:
            units.append((separator, line[start : start + target]))
            start, separator = start + target, ""
        else:
            units.append((separator, line[start:cut]))
            start, separator = cut + 1, " "
    units.append((separator, line[start:]))
    return units


def _units(text: str, target: int) -> list[tuple[str, str]]:
    """Break text into (separator, piece) units no longer than ``2 * target`` characters.

    Paragraphs are the preferred unit; a paragraph that is itself too long falls back to lines.
    """
    units: list[tuple[str, str]] = []
    for paragraph in text.split("\n\n"):
        if not paragraph.strip():
            continue
        if len(paragraph) <= 2 * target:
            units.append(("\n\n", paragraph))
            continue
        separator = "\n\n"
        for line in paragraph.split("\n"):
            units.extend(_line_units(line, separator, target))
            separator = "\n"
    return units


def split_by_size(text: str, target: int = SECTION_TARGET_CHARS) -> list[str]:
    """Split text into parts of roughly ``target`` characters, at paragraph boundaries when
    possible. Joining is greedy: a part is closed when the next unit would push it past target."""
    parts: list[str] = []
    current: list[str] = []
    size = 0
    for separator, piece in _units(text, target):
        if current and size + len(separator) + len(piece) > target:
            parts.append("".join(current))
            current, size = [], 0
        if current:
            current.append(separator)
            size += len(separator)
        current.append(piece)
        size += len(piece)
    if current:
        parts.append("".join(current))
    return [part.strip("\n") for part in parts if part.strip()]


def _heading_title(raw: str) -> str:
    """Heading text without the optional closing ``#`` sequence ("# Title ##" -> "Title")."""
    title = raw.strip()
    without = title.rstrip("#")
    if without != title and (not without or without[-1] in " \t"):
        title = without.rstrip()
    return title


def split_markdown(text: str, preamble_label: str) -> list[tuple[str, str]]:
    """(label, text) sections of a Markdown document, split at level-1 and level-2 ATX headings.

    The heading line stays in its section's text. Text before the first heading is labelled with
    ``preamble_label``. ``#`` lines inside fenced code blocks are code, not headings.
    """
    sections: list[tuple[str, list[str]]] = [(preamble_label, [])]
    fence: str | None = None  # the marker that opened the code block we are inside, if any
    for line in text.split("\n"):
        fence_match = _MD_FENCE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker
            elif (
                marker[0] == fence[0] and len(marker) >= len(fence) and not line[fence_match.end() :].strip()
            ):
                fence = None
        elif fence is None:
            heading = _MD_HEADING.match(line)
            if heading:
                sections.append((clean_label(_heading_title(heading.group(1)), preamble_label), []))
        sections[-1][1].append(line)
    return [(label, "\n".join(lines).strip("\n")) for label, lines in sections]
