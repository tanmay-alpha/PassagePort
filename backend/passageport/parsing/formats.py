"""Format-specific parsers. Each turns the raw bytes of one file into ``ParsedPage`` objects.

These functions run inside the sandboxed child process (see ``isolated.py``); third-party parsers
are imported lazily so the child only pays for the one it needs.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

from passageport.domain import ParsedPage
from passageport.parsing.errors import ParseError
from passageport.parsing.text import (
    MAX_LABEL_CHARS,
    SECTION_TARGET_CHARS,
    clean_label,
    normalize_text,
    split_by_size,
    split_markdown,
)

_DOCX_HEADING_STYLE_IDS = frozenset({"heading1", "heading2", "title"})
_DOCX_HEADING_STYLE_NAMES = frozenset({"heading 1", "heading 2", "title"})


@dataclass(frozen=True, slots=True)
class ParseLimits:
    max_pages: int
    max_document_chars: int


def _too_long(limits: ParseLimits) -> ParseError:
    return ParseError(
        f"This document contains more than {limits.max_document_chars:,} characters of text, "
        "which is over the limit. Split it into smaller files."
    )


def _too_many(count: int, unit: str, limits: ParseLimits) -> ParseError:
    return ParseError(
        f"This document has {count:,} {unit}; the limit is {limits.max_pages:,}. Split it into smaller files."
    )


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ParseError("This file is not valid UTF-8 text.") from None


def _sections_to_pages(sections: list[tuple[str, str]], limits: ParseLimits) -> list[ParsedPage]:
    """Number the non-empty sections. A section far beyond the target size is divided into parts
    so that a single citation target stays readable."""
    pages: list[ParsedPage] = []
    for label, text in sections:
        if not text.strip():
            continue
        parts = split_by_size(text) if len(text) > 2 * SECTION_TARGET_CHARS else [text]
        for index, part in enumerate(parts, start=1):
            suffix = f" (part {index})" if len(parts) > 1 else ""
            part_label = label[: MAX_LABEL_CHARS - len(suffix)].rstrip() + suffix
            pages.append(ParsedPage(number=len(pages) + 1, label=part_label, text=part))
    if not pages:
        raise ParseError("This document contains no text.")
    if len(pages) > limits.max_pages:
        raise _too_many(len(pages), "sections", limits)
    return pages


def _sized_parts(text: str) -> list[tuple[str, str]]:
    return [(f"Part {i}", part) for i, part in enumerate(split_by_size(text), start=1)]


def parse_txt(data: bytes, limits: ParseLimits) -> list[ParsedPage]:
    text = normalize_text(_decode(data), reflow=False)
    if len(text) > limits.max_document_chars:
        raise _too_long(limits)
    return _sections_to_pages(_sized_parts(text), limits)


def parse_md(data: bytes, limits: ParseLimits, title: str | None) -> list[ParsedPage]:
    text = normalize_text(_decode(data), reflow=False)
    if len(text) > limits.max_document_chars:
        raise _too_long(limits)
    preamble = clean_label(title or "", "Introduction")
    return _sections_to_pages(split_markdown(text, preamble), limits)


def parse_pdf(data: bytes, limits: ParseLimits) -> list[ParsedPage]:
    """One ``ParsedPage`` per PDF page. Pages without text are kept (as empty text) so that page
    numbers always match the numbers a PDF viewer shows."""
    from pypdf import PdfReader

    unreadable = ParseError("This file could not be read as a PDF. It may be damaged or incomplete.")
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        encrypted = reader.is_encrypted
    except Exception:
        raise unreadable from None
    if encrypted:
        try:
            # Many "protected" PDFs only restrict printing and open with an empty password.
            opened = bool(reader.decrypt(""))
        except Exception:
            opened = False
        if not opened:
            raise ParseError("This PDF is password-protected. Remove the password and upload it again.")
    try:
        page_count = len(reader.pages)
    except Exception:
        raise unreadable from None
    if page_count == 0:
        raise ParseError("This PDF has no pages.")
    if page_count > limits.max_pages:
        raise _too_many(page_count, "pages", limits)

    pages: list[ParsedPage] = []
    total = 0
    for number in range(1, page_count + 1):
        try:
            raw = reader.pages[number - 1].extract_text() or ""
        except Exception:
            # One damaged page must not make the rest of the document unusable.
            raw = ""
        text = normalize_text(raw, reflow=True)
        total += len(text)
        if total > limits.max_document_chars:
            raise _too_long(limits)
        pages.append(ParsedPage(number=number, label=f"Page {number}", text=text))
    if total == 0:
        raise ParseError(
            "No text could be extracted from this PDF. It is probably a scanned document "
            "(images of pages); OCR is not supported."
        )
    return pages


def _docx_is_heading(paragraph: Any) -> bool:
    try:
        style = paragraph.style
        style_id = (style.style_id or "").lower()
        style_name = (style.name or "").lower()
    except Exception:
        return False
    return style_id in _DOCX_HEADING_STYLE_IDS or style_name in _DOCX_HEADING_STYLE_NAMES


def _docx_table_text(table: Any) -> str:
    rows: list[str] = []
    for row in table.rows:
        seen: set[int] = set()
        cells: list[str] = []
        for cell in row.cells:
            # A horizontally merged cell is reported once per spanned column.
            marker = id(cell._tc)
            if marker in seen:
                continue
            seen.add(marker)
            text = " ".join(cell.text.split())
            if text:
                cells.append(text)
        if cells:
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def parse_docx(data: bytes, limits: ParseLimits, title: str | None) -> list[ParsedPage]:
    """Sections start at Title / Heading 1 / Heading 2 paragraphs; table text is included in
    document order. A document without such headings is divided by size, like a text file."""
    import docx
    from docx.table import Table

    try:
        document = docx.Document(io.BytesIO(data))
        blocks: list[tuple[bool, str]] = []
        total = 0
        for block in document.iter_inner_content():
            if isinstance(block, Table):
                is_heading, raw = False, _docx_table_text(block)
            else:
                is_heading, raw = _docx_is_heading(block), block.text
            text = normalize_text(raw, reflow=True)
            if not text:
                continue
            total += len(text)
            if total > limits.max_document_chars:
                raise _too_long(limits)
            blocks.append((is_heading, text))
    except ParseError:
        raise
    except Exception:
        raise ParseError("This file could not be read as a Word document. It may be damaged.") from None

    if not any(is_heading for is_heading, _ in blocks):
        return _sections_to_pages(_sized_parts("\n\n".join(text for _, text in blocks)), limits)

    preamble = clean_label(title or "", "Introduction")
    sections: list[tuple[str, list[str]]] = [(preamble, [])]
    for is_heading, text in blocks:
        if is_heading:
            sections.append((clean_label(text, preamble), []))
        sections[-1][1].append(text)
    return _sections_to_pages([(label, "\n\n".join(parts)) for label, parts in sections], limits)


def parse_in_process(
    kind: str, data: bytes, limits: ParseLimits, title: str | None = None
) -> list[ParsedPage]:
    """Parse in the current process. Production code goes through ``parse_document`` instead,
    which runs this function in a killable child process."""
    if kind == "pdf":
        return parse_pdf(data, limits)
    if kind == "txt":
        return parse_txt(data, limits)
    if kind == "md":
        return parse_md(data, limits, title)
    if kind == "docx":
        return parse_docx(data, limits, title)
    raise ParseError("This file type is not supported.")
