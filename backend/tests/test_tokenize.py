"""Keyword tokenizer: identifiers, versions and ordinary words must all stay searchable."""

from __future__ import annotations

import pytest

from passageport.search.tokenize import STOPWORDS, matched_surfaces, query_terms, stem, tokenize, tokens


def test_case_folding_and_stopwords() -> None:
    assert tokenize("The Kernel IS the core of an operating system") == [
        "kernel",
        "core",
        "operating",
        "system",
    ]
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
    assert matched_surfaces(text, terms) == ["Queries", "max_chunk_tokens", "max", "chunk", "tokens"]
    assert matched_surfaces(text, set()) == []


def test_very_long_runs_do_not_become_terms() -> None:
    assert tokenize("a" * 100) == []
    assert tokenize("x" * 70 + "_tail") == ["tail"]


def test_oversized_compounds_bypass_the_expansion_cache() -> None:
    from passageport.search.tokenize import MAX_TERM_CHARS, _expand_cached

    _expand_cached.cache_clear()
    for i in range(100):
        assert tokenize("x" * (MAX_TERM_CHARS + 1) + f"_{i}_tail")[-1] == "tail"
    assert _expand_cached.cache_info().currsize == 0
    tokenize("ordinary")
    tokenize("ordinary")
    assert _expand_cached.cache_info().hits == 1


@pytest.mark.parametrize(
    ("source", "query", "expected"),
    [
        ("Straße", "strasse", ["Straße"]),
        ("ＦＵＬＬ－ＷＩＤＴＨ", "full-width", ["ＦＵＬＬ－ＷＩＤＴＨ", "ＦＵＬＬ", "ＷＩＤＴＨ"]),
        ("Don't don’t", "dont", ["Don't", "don’t"]),
        ("1.2.3", "1.2.3", ["1.2.3"]),
        ("maxRetries", "retry", ["maxRetries"]),
        ("Cafe\u0301 ﬁle", "café file", ["Cafe\u0301", "ﬁle"]),
    ],
)
def test_highlights_are_literal_source_substrings(source: str, query: str, expected: list[str]) -> None:
    found = matched_surfaces(source, set(query_terms(query)))
    assert found == expected
    assert all(term in source and term.lower() in source.lower() for term in found)
