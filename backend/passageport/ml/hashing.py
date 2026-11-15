"""Deterministic feature-hashing embedder.

No model download and no learned semantics: it exists so tests, CI and offline smoke runs can
exercise the full pipeline quickly. It is never the default and the UI labels it when active.
"""

from __future__ import annotations

import hashlib
import itertools
import re

import numpy as np

_TOKEN = re.compile(r"[a-z0-9]+")


class HashingEmbedder:
    backend = "hashing"
    model = "feature-hashing"

    def __init__(self, dimensions: int = 256) -> None:
        self.dimensions = dimensions
        self.version = f"hashing:feature-hashing:{dimensions}"

    def _embed(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dimensions, dtype=np.float32)
        tokens = _TOKEN.findall(text.lower())
        for gram in tokens + [f"{a} {b}" for a, b in itertools.pairwise(tokens)]:
            digest = hashlib.blake2b(gram.encode(), digest_size=8).digest()
            idx = int.from_bytes(digest[:4], "little") % self.dimensions
            vec[idx] += 1.0 if digest[4] & 1 else -1.0
        norm = float(np.linalg.norm(vec))
        return vec / norm if norm else vec

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dimensions), dtype=np.float32)
        return np.stack([self._embed(t) for t in texts])

    def embed_query(self, text: str) -> np.ndarray:
        return self._embed(text)

    def count_tokens(self, text: str) -> int:
        return len(_TOKEN.findall(text.lower()))
