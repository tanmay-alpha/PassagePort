"""Chunk offsets, coverage and deterministic ids."""

from __future__ import annotations

import dataclasses
import itertools

import pytest
from hypothesis import HealthCheck, given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

import passageport.chunking as chunking
from passageport.chunking import chunk_id, chunk_pages, chunker_version
from passageport.config import Settings
from passageport.domain import ChunkDraft, ParsedPage
from passageport.ml.hashing import HashingEmbedder

EMBEDDER = HashingEmbedder()

# Words, punctuation, every kind of whitespace, non-ASCII letters and an astral-plane character.
_ALPHABET = st.sampled_from(
    [*"abcdefgh XYZ019", " ", "  ", "\n", "\n\n", "\t", ".", ", ", "; ", "é", "ß", "漢", "😀", "-"]
)
_TEXT = st.lists(_ALPHABET, max_size=400).map("".join)


def _settings(max_tokens: int, overlap: int = 0) -> Settings:
    return Settings(_env_file=None, chunk_max_tokens=max_tokens, chunk_overlap_tokens=overlap)


def _squash(text: str) -> str:
    return "".join(text.split())


@hypothesis_settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(texts=st.lists(_TEXT, min_size=1, max_size=3), max_tokens=st.integers(1, 40))
def test_offsets_always_reproduce_the_chunk_text(texts, max_tokens):
    pages = [ParsedPage(number=i, label=f"Page {i}", text=text) for i, text in enumerate(texts, start=1)]
    by_number = {page.number: page for page in pages}

    drafts = chunk_pages(pages, EMBEDDER, _settings(max_tokens))

    assert [d.ordinal for d in drafts] == list(range(len(drafts)))
    for draft in drafts:
        page_text = by_number[draft.page_number].text
        assert 0 <= draft.char_start < draft.char_end <= len(page_text)
        assert page_text[draft.char_start : draft.char_end] == draft.text  # the invariant
        assert draft.text == draft.text.strip() and draft.text
        assert draft.token_count == EMBEDDER.count_tokens(draft.text)
    # Without overlap the chunks of a page are disjoint, in reading order, and lose no text.
    for page in pages:
        mine = [d for d in drafts if d.page_number == page.number]
        assert all(a.char_end <= b.char_start for a, b in itertools.pairwise(mine))
        assert _squash("".join(d.text for d in mine)) == _squash(page.text)


@hypothesis_settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(text=_TEXT, max_tokens=st.integers(2, 30), overlap=st.integers(1, 40))
def test_offsets_hold_with_overlap(text, max_tokens, overlap):
    page = ParsedPage(number=1, label="Page 1", text=text)
    drafts = chunk_pages([page], EMBEDDER, _settings(max_tokens, overlap))
    spans = [(d.char_start, d.char_end) for d in drafts]
    assert len(set(spans)) == len(spans)
    for draft in drafts:
        assert text[draft.char_start : draft.char_end] == draft.text
        assert draft.text.strip() == draft.text != ""
    covered = set()
    for start, end in spans:
        covered.update(range(start, end))
    assert all(index in covered for index, ch in enumerate(text) if not ch.isspace())


def test_chunks_respect_the_token_budget_and_never_span_pages():
    sentence = "Retrieval quality depends on chunk boundaries and on the tokenizer used to size them. "
    pages = [
        ParsedPage(1, "Page 1", sentence * 40),
        ParsedPage(2, "Page 2", ""),
        ParsedPage(3, "Page 3", sentence * 5),
    ]
    drafts = chunk_pages(pages, EMBEDDER, _settings(32))

    assert len(drafts) > 10
    assert all(d.token_count <= 32 for d in drafts)
    assert {d.page_number for d in drafts} == {1, 3}  # whitespace-only pages produce nothing
    assert [d.page_number for d in drafts] == sorted(d.page_number for d in drafts)


def test_whitespace_only_pages_produce_no_chunks():
    pages = [ParsedPage(1, "Page 1", ""), ParsedPage(2, "Page 2", " \n\t \n")]
    assert chunk_pages(pages, EMBEDDER, _settings(16)) == []


def test_chunking_is_deterministic():
    text = "One sentence here. Another sentence there.\n\nA new paragraph with more words in it. " * 8
    pages = [ParsedPage(1, "Page 1", text)]
    assert chunk_pages(pages, EMBEDDER, _settings(20)) == chunk_pages(pages, EMBEDDER, _settings(20))


def test_chunk_ids_are_deterministic_and_position_sensitive():
    draft = ChunkDraft(ordinal=0, page_number=2, char_start=10, char_end=90, text="ignored", token_count=5)
    version = "semchunk-1:t256:o0"
    first = chunk_id("doc-a", draft, version)

    assert first == chunk_id("doc-a", draft, version)
    assert len(first) == 24 and int(first, 16) >= 0
    # Text and ordinal are not part of the identity; document, position and chunker version are.
    assert first == chunk_id("doc-a", dataclasses.replace(draft, text="other", ordinal=7), version)
    different = {
        chunk_id("doc-b", draft, version),
        chunk_id("doc-a", dataclasses.replace(draft, page_number=3), version),
        chunk_id("doc-a", dataclasses.replace(draft, char_start=11), version),
        chunk_id("doc-a", dataclasses.replace(draft, char_end=91), version),
        chunk_id("doc-a", draft, "semchunk-1:t128:o0"),
    }
    assert first not in different and len(different) == 5


def test_chunker_version_tracks_size_and_overlap(make_settings):
    assert chunker_version(_settings(256)) == f"{chunking.ALGORITHM}:t256:o0"
    assert chunker_version(_settings(128, 16)) == f"{chunking.ALGORITHM}:t128:o16"
    assert len(chunker_version(_settings(100_000, 99_999))) <= 60  # fits documents.chunker_version

    # The module-level constant follows the process settings, and is the default for chunk ids.
    make_settings(chunk_max_tokens=77)
    assert f"{chunking.ALGORITHM}:t77:o0" == chunking.CHUNKER_VERSION
    draft = ChunkDraft(0, 1, 0, 5, "hello", 1)
    assert chunk_id("doc", draft) == chunk_id("doc", draft, chunking.CHUNKER_VERSION)
    with pytest.raises(AttributeError):
        _ = chunking.NO_SUCH_NAME
