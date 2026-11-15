"""Optional PyTorch backend (``pip install passageport[heavy]``): sentence-transformers models.

This is how the upstream project's ``Alibaba-NLP/gte-multilingual-*`` models stay available.
``torch`` and ``sentence_transformers`` are imported inside methods only, so the default install
(fastembed) never needs them and importing this module is free.
"""

from __future__ import annotations

import inspect
import threading
from pathlib import Path
from typing import Any

import numpy as np

# ``trust_remote_code=True`` makes transformers download and EXECUTE Python shipped inside the
# model repository. The upstream gte-multilingual models need it (their architecture lives in the
# ``Alibaba-NLP/new-impl`` repository, not in transformers). Upstream enabled it for whatever model
# name was configured, which turns a configuration value into arbitrary code execution. Here it is
# limited to the exact repositories below; every other model is loaded with remote code disabled
# and fails loudly if it would need it.
TRUSTED_REMOTE_CODE_MODELS = frozenset(
    {
        "Alibaba-NLP/gte-multilingual-base",
        "Alibaba-NLP/gte-multilingual-reranker-base",
    }
)

# Output sizes that are known without loading the model, so status pages do not trigger a load.
_KNOWN_DIMENSIONS = {
    "Alibaba-NLP/gte-multilingual-base": 768,
    "sentence-transformers/all-MiniLM-L6-v2": 384,
    "BAAI/bge-small-en-v1.5": 384,
}


def _trusts_remote_code(model: str) -> bool:
    return model in TRUSTED_REMOTE_CODE_MODELS


class SentenceTransformerEmbedder:
    backend = "sentence-transformers"

    def __init__(self, model: str, cache_dir: Path | str | None = None) -> None:
        self.model = model
        self._cache_dir = str(cache_dir) if cache_dir else None
        self._lock = threading.Lock()
        self._engine: Any = None
        self._dimensions = _KNOWN_DIMENSIONS.get(model)

    def _load(self) -> Any:
        if self._engine is None:
            with self._lock:
                if self._engine is None:
                    from sentence_transformers import SentenceTransformer

                    engine = SentenceTransformer(
                        self.model,
                        cache_folder=self._cache_dir,
                        trust_remote_code=_trusts_remote_code(self.model),
                        device="cpu",
                    )
                    dimensions = getattr(engine, "get_embedding_dimension", None) or (
                        engine.get_sentence_embedding_dimension
                    )
                    self._dimensions = int(dimensions())
                    self._engine = engine
        return self._engine

    @property
    def dimensions(self) -> int:
        if self._dimensions is None:
            self._load()
        return int(self._dimensions or 0)

    @property
    def version(self) -> str:
        return f"sentence-transformers:{self.model}:{self.dimensions}"

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dimensions), dtype=np.float32)
        vectors = self._load().encode(
            texts, batch_size=16, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False
        )
        return np.asarray(vectors, dtype=np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        return self.embed_documents([text])[0]

    def count_tokens(self, text: str) -> int:
        tokenizer = self._load().tokenizer
        return len(tokenizer(text, add_special_tokens=False, truncation=False)["input_ids"])


class SentenceTransformerReranker:
    backend = "sentence-transformers"

    def __init__(self, model: str, cache_dir: Path | str | None = None) -> None:
        self.model = model
        self._cache_dir = str(cache_dir) if cache_dir else None
        self._lock = threading.Lock()
        self._engine: Any = None
        self._predict_kwargs: dict[str, Any] = {}

    def _load(self) -> Any:
        if self._engine is None:
            with self._lock:
                if self._engine is None:
                    import torch
                    from sentence_transformers import CrossEncoder

                    init_params = inspect.signature(CrossEncoder.__init__).parameters
                    cache_key = "cache_folder" if "cache_folder" in init_params else "cache_dir"
                    engine = CrossEncoder(
                        self.model,
                        trust_remote_code=_trusts_remote_code(self.model),
                        device="cpu",
                        **{cache_key: self._cache_dir},
                    )
                    # The protocol promises raw logits (thresholds are calibrated on them), while
                    # CrossEncoder applies a sigmoid by default. The keyword was renamed in v4.
                    predict_params = inspect.signature(engine.predict).parameters
                    activation = "activation_fn" if "activation_fn" in predict_params else "activation_fct"
                    self._predict_kwargs = {activation: torch.nn.Identity()}
                    self._engine = engine
        return self._engine

    def score(self, query: str, passages: list[str]) -> list[float]:
        if not passages:
            return []
        engine = self._load()
        scores = engine.predict(
            [(query, passage) for passage in passages],
            batch_size=16,
            show_progress_bar=False,
            convert_to_numpy=True,
            **self._predict_kwargs,
        )
        return [float(s) for s in np.asarray(scores).reshape(-1)]
