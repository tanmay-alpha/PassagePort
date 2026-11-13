"""Turn an uploaded file into pages of text.

``parse_document`` is the only entry point the rest of the application uses. It always parses in a
sandboxed child process; ``parse_in_process`` exists for the child itself and for unit tests.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from passageport.domain import ParsedPage
from passageport.parsing.errors import ParseError
from passageport.parsing.formats import ParseLimits, parse_in_process
from passageport.parsing.isolated import run_isolated

if TYPE_CHECKING:
    from passageport.config import Settings

__all__ = ["ParseError", "ParseLimits", "limits_from", "parse_document", "parse_in_process"]


def limits_from(settings: Settings) -> ParseLimits:
    return ParseLimits(max_pages=settings.max_pages, max_document_chars=settings.max_document_chars)


def _parse_job(kind: str, data: bytes, limits: ParseLimits, title: str | None) -> list[tuple[int, str, str]]:
    """Child-process entry point. Returns plain tuples to keep the pickled result minimal."""
    return [(p.number, p.label, p.text) for p in parse_in_process(kind, data, limits, title)]


def parse_document(kind: str, data: bytes, settings: Settings, title: str | None = None) -> list[ParsedPage]:
    """Parse ``data`` (a ``pdf``/``txt``/``md``/``docx`` file) into pages.

    ``title`` labels the text that precedes the first heading of a Markdown or Word document.
    Raises ``ParseError`` (user-safe message) for unreadable, encrypted, scanned, oversized or
    pathological files, including ones that exceed ``settings.parse_timeout_seconds``.
    """
    rows = run_isolated(
        _parse_job, (kind, data, limits_from(settings), title), settings.parse_timeout_seconds
    )
    return [ParsedPage(number=number, label=label, text=text) for number, label, text in rows]
