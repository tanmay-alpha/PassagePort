"""Split pages into retrieval chunks with exact character offsets.

The invariant every consumer relies on (highlighting a citation, resolving a chunk):

    page.text[chunk.char_start:chunk.char_end] == chunk.text

It holds by construction here: a chunk's text is always *taken from* the page by its offsets,
never copied from the splitter's output. Chunks never span pages.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from functools import lru_cache
from typing import cast

import semchunk

from passageport.config import Settings, get_settings
from passageport.domain import ChunkDraft, ParsedPage
from passageport.ml.protocols import Embedder

# Bump when a change could move chunk boundaries (splitter upgrade, trimming rules, ...): stored
# documents are then reported as stale and get new chunk ids when re-indexed.
ALGORITHM = "semchunk-1"
_TOKEN_CACHE_SIZE = 8192


def chunker_version(settings: Settings) -> str:
    """Identifies everything that determines chunk boundaries: algorithm, size and overlap."""
    return f"{ALGORITHM}:t{settings.chunk_max_tokens}:o{settings.chunk_overlap_tokens}"


def __getattr__(name: str) -> str:
    # ``CHUNKER_VERSION`` depends on the configured chunk size, so it is resolved on access
    # instead of being frozen at import time.
    if name == "CHUNKER_VERSION":
        return chunker_version(get_settings())
    raise AttributeError(name)


def _trim(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def _spans(
    text: str, max_tokens: int, overlap: int, count_tokens: Callable[[str], int]
) -> list[tuple[int, int]]:
    """(start, end) offsets of the chunks of one page, in reading order."""
    pieces, offsets = cast(
        "tuple[list[str], list[tuple[int, int]]]",
        semchunk.chunk(
            text,
            max_tokens,
            count_tokens,
            memoize=False,
            offsets=True,
            overlap=min(overlap, max_tokens - 1) or None,
        ),
    )
    spans: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    cursor = 0
    for piece, (reported_start, reported_end) in zip(pieces, offsets, strict=True):
        start, end = reported_start, reported_end
        if not (0 <= start <= end <= len(text)) or text[start:end] != piece:
            # The splitter's bookkeeping disagrees with its own output: locate the piece instead.
            found = text.find(piece, cursor)
            if found == -1:
                found = text.find(piece)
            if found == -1:
                continue
            start, end = found, found + len(piece)
        start, end = _trim(text, start, end)
        if start == end or (start, end) in seen:
            continue
        seen.add((start, end))
        spans.append((start, end))
        cursor = start
    return spans


def chunk_pages(pages: Sequence[ParsedPage], embedder: Embedder, settings: Settings) -> list[ChunkDraft]:
    """Chunk every page independently, sized with the embedding model's own tokenizer."""
    # A per-call cache: the splitter counts the same substrings many times, but nothing derived
    # from document text may outlive the indexing job.
    count_tokens = lru_cache(maxsize=_TOKEN_CACHE_SIZE)(embedder.count_tokens)
    drafts: list[ChunkDraft] = []
    for page in pages:
        if not page.text.strip():
            continue
        for start, end in _spans(
            page.text, settings.chunk_max_tokens, settings.chunk_overlap_tokens, count_tokens
        ):
            text = page.text[start:end]
            drafts.append(
                ChunkDraft(
                    ordinal=len(drafts),
                    page_number=page.number,
                    char_start=start,
                    char_end=end,
                    text=text,
                    token_count=count_tokens(text),
                )
            )
    return drafts


def chunk_id(document_id: str, draft: ChunkDraft, version: str | None = None) -> str:
    """Deterministic id: re-indexing an unchanged document with the same chunker settings yields
    the same ids, so saved citations keep resolving."""
    version = version or chunker_version(get_settings())
    key = f"{document_id}|{draft.page_number}|{draft.char_start}|{draft.char_end}|{version}"
    return hashlib.sha256(key.encode()).hexdigest()[:24]
