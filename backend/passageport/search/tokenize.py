"""Keyword tokenizer for technical documents.

Plain word-splitting loses exactly the things people look up in manuals and specs: error codes,
configuration keys, protocol names and version numbers. This tokenizer therefore keeps a compound
such as ``max_chunk_tokens``, ``HTTP/2`` or ``v1.5`` as one term *and* also emits its parts, so both
the exact identifier and its ordinary words stay searchable:

    "Set max_chunk_tokens for HTTP/2"  ->  set, max_chunk_tokens, max, chunk, token, http/2, http, 2

Other rules: Unicode NFKC + case-folding; camelCase is split (``maxRetries`` -> maxretries, max,
retry); purely numeric compounds (``1.2.3``, ``10.5``) stay whole; a small stopword list; and
plural folding (see ``STEMMING``).
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from typing import NamedTuple

# Stemming strength, chosen by measurement (docs/SEARCH_EVALUATION.md, "Keyword tokenizer"):
#   "none"   - no stemming
#   "plural" - fold regular English plurals only (Harman's S-stemmer)
#   "light"  - plural folding plus -ing / -ed / -ly stripping
STEMMING = "plural"
STEMMING_MODES = ("none", "plural", "light")
TOKENIZER_NAME = f"unicode case-fold, identifier-aware (compound + parts), stopwords, stemming: {STEMMING}"

MAX_TERM_CHARS = 64

STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "should",
        "than",
        "that",
        "the",
        "their",
        "then",
        "there",
        "these",
        "they",
        "this",
        "to",
        "was",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
    ]
)

# A run of letters/digits, optionally continued through single connector characters. ``_`` is a
# connector (not a word character) so snake_case splits into parts.
_WORD = r"[^\W_]+"
_COMPOUND = re.compile(rf"{_WORD}(?:[_\-./:+#]{_WORD})*", re.UNICODE)
_CONNECTOR = re.compile(r"[_\-./:+#]")
_APOSTROPHE = re.compile(r"(?<=[^\W_])['\u2019](?=[^\W_])")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_NUMERIC = re.compile(r"\d+(?:[.:]\d+)*")


class Token(NamedTuple):
    term: str  # normalized index term
    surface: str  # lower-cased normalized surface; matched_surfaces resolves it to source text


# Plurals the suffix rules get wrong, and singulars that merely look plural.
_IRREGULAR = {
    "caches": "cache",
    "indices": "index",
    "matrices": "matrix",
    "vertices": "vertex",
    "analyses": "analysis",
    "statuses": "status",
    "aliases": "alias",
    "alias": "alias",
    "bias": "bias",
    "canvas": "canvas",
    "always": "always",
    "across": "across",
    "series": "series",
    "kubernetes": "kubernetes",
    "https": "https",
    "dns": "dns",
    "tls": "tls",
}
_ES_AFTER = ("ss", "x", "z", "sh", "ch")


def _stem_plural(word: str) -> str:  # noqa: PLR0911 - one return per suffix rule
    """Fold regular English plurals to the singular; nothing else (after Harman's S-stemmer)."""
    if len(word) <= 3 or not word.endswith("s"):
        return word
    if word in _IRREGULAR:
        return _IRREGULAR[word]
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("es"):
        base = word[:-2]
        if base.endswith(_ES_AFTER):
            return base  # processes -> process, indexes -> index, batches -> batch
        if word.endswith(("aes", "ees", "oes")):
            return word
        return word[:-1]  # files -> file, nodes -> node
    if word.endswith(("us", "ss", "is")):
        return word
    return word[:-1]


def _stem_light(word: str) -> str:
    word = _stem_plural(word)
    for suffix, minimum in (("ing", 6), ("ed", 5), ("ly", 5)):
        if word.endswith(suffix) and len(word) >= minimum:
            return word[: -len(suffix)]
    return word


def stem(word: str, mode: str | None = None) -> str:
    """Stem one case-folded word. Identifiers with digits and non-ASCII words are left alone."""
    mode = STEMMING if mode is None else mode
    if mode == "none" or not word.isascii() or not word.isalpha():
        return word
    return _stem_light(word) if mode == "light" else _stem_plural(word)


def _expand(raw: str, mode: str) -> tuple[Token, ...]:
    """Expand oversized compounds without retaining their unbounded raw strings in the cache."""
    if len(raw) > MAX_TERM_CHARS:
        return _expand_uncached(raw, mode)
    return _expand_cached(raw, mode)


@lru_cache(maxsize=65536)
def _expand_cached(raw: str, mode: str) -> tuple[Token, ...]:
    return _expand_uncached(raw, mode)


def _expand_uncached(raw: str, mode: str) -> tuple[Token, ...]:
    """All index terms of one compound as matched by ``_COMPOUND``."""
    out: list[Token] = []
    surface = raw.casefold()
    pieces = _CONNECTOR.split(raw)
    if len(pieces) > 1 and len(raw) <= MAX_TERM_CHARS:
        out.append(Token(surface, surface))
        if _NUMERIC.fullmatch(raw):
            return tuple(out)  # "1.2.3": the parts "1", "2", "3" would only add noise
    for piece in pieces:
        folded_piece = piece.casefold()
        if len(folded_piece) > MAX_TERM_CHARS:
            continue
        words = _CAMEL.split(piece)
        if len(words) == 1:
            if folded_piece not in STOPWORDS:
                out.append(Token(stem(folded_piece, mode), folded_piece))
            continue
        # camelCase: keep the identifier as written and make each humped word searchable.
        out.append(Token(folded_piece, folded_piece))
        for word in words:
            folded = word.casefold()
            if folded and folded not in STOPWORDS:
                out.append(Token(stem(folded, mode), folded_piece))
    return tuple(out)


def tokens(text: str, stemming: str | None = None) -> list[Token]:
    """Index terms of ``text`` in reading order, each with the surface form it came from."""
    mode = STEMMING if stemming is None else stemming
    text = _APOSTROPHE.sub("", unicodedata.normalize("NFKC", text))
    out: list[Token] = []
    for raw in _COMPOUND.findall(text):
        out.extend(_expand(raw, mode))
    return out


def tokenize(text: str, stemming: str | None = None) -> list[str]:
    """Index terms only (duplicates kept: term frequency matters to BM25)."""
    return [token.term for token in tokens(text, stemming)]


def query_terms(query: str, stemming: str | None = None) -> list[str]:
    """Distinct index terms of a query, in order of first appearance."""
    return list(dict.fromkeys(tokenize(query, stemming)))


def matched_surfaces(text: str, terms: set[str] | frozenset[str], stemming: str | None = None) -> list[str]:
    """Return literal source substrings, never case-folded or compatibility-normalized spellings.

    Normalization is many-to-one (``Straße``/``strasse``, ligatures, full-width text, apostrophes).
    Track source spans through that normalization so every returned highlight occurs in the passage.
    """
    if not terms:
        return []
    normalized: list[str] = []
    spans: list[tuple[int, int]] = []
    # Normalize a base character with its combining marks together, preserving canonical composition.
    for cluster in re.finditer(r".(?:[\u0300-\u036f]*)", text, re.DOTALL):
        normalized_cluster = unicodedata.normalize("NFKC", cluster.group())
        normalized.extend(normalized_cluster)
        spans.extend([(cluster.start(), cluster.end())] * len(normalized_cluster))
    source = "".join(normalized)
    removed = {m.start() for m in _APOSTROPHE.finditer(source)}
    if removed:
        spans = [span for i, span in enumerate(spans) if i not in removed]
        source = "".join(ch for i, ch in enumerate(source) if i not in removed)
    mode = STEMMING if stemming is None else stemming
    found: dict[str, str] = {}
    for match in _COMPOUND.finditer(source):
        folded = match.group().casefold()
        folded_positions = [i for i, ch in enumerate(match.group()) for _ in ch.casefold()]
        for token in _expand(match.group(), mode):
            if token.term not in terms:
                continue
            offset = folded.find(token.surface)
            start = match.start() + folded_positions[offset]
            end = match.start() + folded_positions[offset + len(token.surface) - 1] + 1
            written = text[spans[start][0] : spans[end - 1][1]]
            found.setdefault(written.lower(), written)
    return list(found.values())
