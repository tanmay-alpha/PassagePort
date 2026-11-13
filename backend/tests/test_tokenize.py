"""Keyword tokenizer: identifiers, versions and ordinary words must all stay searchable."""

from __future__ import annotations

import pytest

from passageport.search.tokenize import STOPWORDS, matched_surfaces, query_terms, stem, tokenize, tokens


def test_case_folding_and_stopwords() -> None:
    assert tokenize("The Kernel IS the core of an operating system") == ["kernel", "core", "operating", "system"]
    assert "the" in STOPWORDS


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("ECONNRESET", ["econnreset"]),
        ("max_chunk_tokens", ["max_chunk_tokens", "max", "chunk", "token"]),
        ("HTTP/2", ["http/2", "http", "2"]),
        ("bge-small-en-v1.5", ["bge-small-en-v1.5", "bge", "small", "en", "v1", "5"]),
        ("node.js", ["node.js", "node", "js"]),
        ("SQLSTATE 40001", ["sqlstate", "40001"]),
    ],
)
def test_identifiers_emit_compound_and_parts(text: str, expected: list[str]) -> None:
    assert tokenize(text) == expected


def test_version_numbers_stay_whole() -> None:
    assert tokenize("upgrade from 1.2.3 to 10.5") == ["upgrade", "1.2.3", "10.5"]
    assert tokenize("released v2.1") == ["released", "v2.1", "v2", "1"]


def test_camel_case_is_split_and_kept() -> None:
    assert tokenize("maxRetries") == ["maxretries", "max", "retry"]
    assert tokenize("HTTPServer") == ["httpserver", "http", "server"]


def test_sentence_punctuation_is_not_part_of_a_term() -> None:
    assert tokenize("Use TLS. Always restart (twice)!") == ["use", "tls", "always", "restart", "twice"]


def test_unicode_words_are_kept_and_normalized() -> None:
    assert tokenize("Größe café naïve") == ["grösse", "café", "naïve"]
    assert tokenize("ﬁle") == ["file"]  # NFKC folds the ligature
    assert tokenize("日本語 テスト") == ["日本語", "テスト"]


def test_apostrophes_do_not_split_words() -> None:
    assert tokenize("the user's password doesn't expire") == ["user", "password", "doesnt", "expire"]


def test_plural_folding_matches_singular_and_plural() -> None:
    for singular, plural in [
        ("query", "queries"),
        ("index", "indexes"),
        ("process", "processes"),
        ("cache", "caches"),
        ("file", "files"),
        ("batch", "batches"),
        ("replica", "replicas"),
    ]:
        assert stem(plural, "plural") == stem(singular, "plural") == singular
    for unchanged in ("status", "analysis", "class", "dns", "bus"):
        assert stem(unchanged, "plural") == unchanged


def test_stemming_modes() -> None:
    assert stem("indexes", "none") == "indexes"
    assert stem("indexing", "plural") == "indexing"
    assert stem("indexing", "light") == "index"
    assert stem("retried", "light") == "retri"
    assert stem("v2", "light") == "v2"  # identifiers with digits are never stemmed
    assert tokenize("Retries failed", stemming="none") == ["retries", "failed"]


def test_query_terms_are_distinct_and_ordered() -> None:
    assert query_terms("timeout timeouts TIMEOUT retry") == ["timeout", "retry"]
    assert query_terms("what is the") == []


def test_tokens_keep_the_surface_form_for_highlighting() -> None:
    assert [(t.term, t.surface) for t in tokens("Queries hit max_chunk_tokens")] == [
        ("query", "queries"),
        ("hit", "hit"),
        ("max_chunk_tokens", "max_chunk_tokens"),
        ("max", "max"),
        ("chunk", "chunk"),
        ("token", "tokens"),
    ]


def test_matched_surfaces_returns_words_as_written() -> None:
    terms = set(query_terms("query max_chunk_tokens"))
    text = "The Queries hit max_chunk_tokens. More queries follow."
    assert matched_surfaces(text, terms) == ["queries", "max_chunk_tokens", "max", "chunk", "tokens"]
    assert matched_surfaces(text, set()) == []


def test_very_long_runs_do_not_become_terms() -> None:
    assert tokenize("a" * 100) == []
    assert tokenize("x" * 70 + "_tail") == ["tail"]
