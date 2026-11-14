"""Default model backend: fastembed (ONNX Runtime on CPU, no PyTorch).

Models are downloaded on first use and loaded lazily, so importing this module, constructing the
classes and reading ``version``/``dimensions`` never touches the network or allocates a model.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np

# Small batches of similar-length texts: padding to the longest text of a large mixed batch wastes
# most of the compute and makes attention buffers (batch x heads x length^2) dominate memory.
# Measured on the reference machine: batch 8 embeds ~40% faster than batch 32.
_BATCH_SIZE = 8


def _by_length(texts: list[str]) -> list[int]:
    return sorted(range(len(texts)), key=lambda i: len(texts[i]))


def _normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (matrix / norms).astype(np.float32, copy=False)


def _dimensions_of(model: str) -> int:
    """Embedding size from fastembed's static model table (no download)."""
    from fastembed import TextEmbedding

    for entry in TextEmbedding.list_supported_models():
        if str(entry["model"]).lower() == model.lower():
            return int(entry["dim"])
    raise ValueError(f"fastembed does not support embedding model {model!r}")


class FastEmbedEmbedder:
    backend = "fastembed"

    def __init__(self, model: str, cache_dir: Path | str | None = None) -> None:
        self.model = model
        self.dimensions = _dimensions_of(model)
        self.version = f"fastembed:{model}:{self.dimensions}"
        self._cache_dir = str(cache_dir) if cache_dir else None
        self._lock = threading.Lock()
        self._engine: Any = None
        self._tokenizer: Any = None

    def _load(self) -> Any:
        # Double-checked: after the first load the hot path takes no lock. ONNX Runtime sessions
        # and Rust tokenizers are safe to call from several threads at once.
        if self._engine is None:
            with self._lock:
                if self._engine is None:
                    from fastembed import TextEmbedding
                    from tokenizers import Tokenizer

                    engine: Any = TextEmbedding(self.model, cache_dir=self._cache_dir)
                    # The model's own tokenizer truncates at the context window. Chunk sizing needs
                    # the true length, so token counting uses an untruncated copy.
                    tokenizer = Tokenizer.from_str(engine.model.tokenizer.to_str())
                    tokenizer.no_truncation()
                    tokenizer.no_padding()
                    self._tokenizer = tokenizer
                    self._engine = engine
        return self._engine

    @property
    def model_dir(self) -> Path:
        """Directory holding the downloaded model files (used to report size on disk)."""
        return Path(self._load().model._model_dir)

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dimensions), dtype=np.float32)
        order = _by_length(texts)
        vectors = np.asarray(
            list(self._load().embed([texts[i] for i in order], batch_size=_BATCH_SIZE)), dtype=np.float32
        )
        restored = np.empty_like(vectors)
        restored[order] = vectors
        return _normalize(restored)

    def embed_query(self, text: str) -> np.ndarray:
        vector = next(iter(self._load().query_embed(text)))
        return _normalize(np.asarray(vector, dtype=np.float32).reshape(1, -1))[0]

    def count_tokens(self, text: str) -> int:
        self._load()
        return len(self._tokenizer.encode(text, add_special_tokens=False).ids)


class FastEmbedReranker:
    backend = "fastembed"

    def __init__(self, model: str, cache_dir: Path | str | None = None) -> None:
        self.model = model
        self._cache_dir = str(cache_dir) if cache_dir else None
        self._lock = threading.Lock()
        self._engine: Any = None

    def _load(self) -> Any:
        if self._engine is None:
            with self._lock:
                if self._engine is None:
                    from fastembed.rerank.cross_encoder import TextCrossEncoder

                    self._engine = TextCrossEncoder(self.model, cache_dir=self._cache_dir)
        return self._engine

    @property
    def model_dir(self) -> Path:
        return Path(self._load().model._model_dir)

    def score(self, query: str, passages: list[str]) -> list[float]:
        if not passages:
            return []
        order = _by_length(passages)
        scores = list(self._load().rerank(query, [passages[i] for i in order], batch_size=_BATCH_SIZE))
        if len(scores) != len(passages):
            # Preserve malformed output for retrieval's controlled skip; never partially reorder it.
            return [float(score) for score in scores]
        restored = [0.0] * len(passages)
        for position, score in zip(order, scores, strict=True):
            restored[position] = float(score)
        return restored
