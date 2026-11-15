"""Model construction from settings. Models load lazily and once per process."""

from __future__ import annotations

import threading

from passageport.config import Settings, get_settings
from passageport.ml.protocols import Embedder, Reranker

_lock = threading.Lock()
_embedder: Embedder | None = None
_reranker: Reranker | None = None
_reranker_loaded = False


def build_embedder(settings: Settings) -> Embedder:
    if settings.embedding_backend == "hashing":
        from passageport.ml.hashing import HashingEmbedder

        return HashingEmbedder()
    if settings.embedding_backend == "fastembed":
        from passageport.ml.fastembed_backend import FastEmbedEmbedder

        return FastEmbedEmbedder(settings.embedding_model, cache_dir=settings.model_cache_dir)
    from passageport.ml.st_backend import SentenceTransformerEmbedder

    return SentenceTransformerEmbedder(settings.embedding_model, cache_dir=settings.model_cache_dir)


def build_reranker(settings: Settings) -> Reranker | None:
    if settings.reranker_backend == "none":
        return None
    if settings.reranker_backend == "fastembed":
        from passageport.ml.fastembed_backend import FastEmbedReranker

        return FastEmbedReranker(settings.reranker_model, cache_dir=settings.model_cache_dir)
    from passageport.ml.st_backend import SentenceTransformerReranker

    return SentenceTransformerReranker(settings.reranker_model, cache_dir=settings.model_cache_dir)


def get_embedder() -> Embedder:
    global _embedder
    with _lock:
        if _embedder is None:
            _embedder = build_embedder(get_settings())
        return _embedder


def get_reranker() -> Reranker | None:
    global _reranker, _reranker_loaded
    with _lock:
        if not _reranker_loaded:
            _reranker = build_reranker(get_settings())
            _reranker_loaded = True
        return _reranker


def models_loaded() -> dict[str, bool]:
    return {"embedder": _embedder is not None, "reranker": _reranker is not None}


def reset_models() -> None:
    """Drop cached models (tests, settings changes)."""
    global _embedder, _reranker, _reranker_loaded
    with _lock:
        _embedder = None
        _reranker = None
        _reranker_loaded = False
