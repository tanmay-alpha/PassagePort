"""Plain data types passed between ingestion, storage and search."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True, slots=True)
class User:
    id: str
    username: str
    is_guest: bool = False


@dataclass(frozen=True, slots=True)
class ParsedPage:
    """One citation unit produced by a parser: a PDF page or a text/Markdown/DOCX section."""

    number: int  # 1-based
    label: str  # "Page 3" or a section heading
    text: str


@dataclass(frozen=True, slots=True)
class ChunkDraft:
    """A chunk before it is embedded. Offsets index into the text of ``page_number``."""

    ordinal: int
    page_number: int
    char_start: int
    char_end: int
    text: str
    token_count: int


@dataclass(frozen=True, slots=True)
class IndexedChunk:
    """A stored chunk together with what a citation needs. Returned by the chunk repository."""

    chunk_id: str
    document_id: str
    document_title: str
    document_kind: str  # pdf | txt | md | docx
    page_number: int
    page_label: str
    char_start: int
    char_end: int
    text: str
    token_count: int
    embedding: np.ndarray  # (dimensions,) float32, L2-normalized


def locator_kind(document_kind: str) -> str:
    return "page" if document_kind == "pdf" else "section"
