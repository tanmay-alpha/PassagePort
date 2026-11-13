"""Interfaces between ingestion/search code and concrete model backends."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import numpy as np


@runtime_checkable
class Embedder(Protocol):
    #: Stable identifier stored with every chunk, e.g. "fastembed:BAAI/bge-small-en-v1.5:384".
    #: Vectors with different versions are never compared.
    version: str
    backend: str
    model: str
    dimensions: int

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        """(n, dimensions) float32, L2-normalized."""
        ...

    def embed_query(self, text: str) -> np.ndarray:
        """(dimensions,) float32, L2-normalized."""
        ...

    def count_tokens(self, text: str) -> int: ...


@runtime_checkable
class Reranker(Protocol):
    backend: str
    model: str

    def score(self, query: str, passages: list[str]) -> list[float]:
        """One relevance score per passage; higher is better. Raw model logits."""
        ...


def to_blob(vector: np.ndarray) -> bytes:
    return np.ascontiguousarray(vector, dtype="<f4").tobytes()


def from_blob(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype="<f4")
