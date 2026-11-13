"""Download the configured embedding and reranker models into ``PP_MODEL_CACHE_DIR``.

Run at image build time (``PRELOAD_MODELS=1``) so a container can start and index documents
without internet access. Models are loaded through the application's own registry, so the cache
layout is exactly what the server looks for at runtime.

After downloading, the models are loaded a second time in a fresh process with the Hugging Face
hub forced offline. A build therefore fails if the image would still need the network.
"""

from __future__ import annotations

import os
import subprocess
import sys

from passageport.config import Settings
from passageport.ml.registry import build_embedder, build_reranker

OFFLINE_FLAG = "--verify-offline"


def load_models(settings: Settings) -> None:
    """Build both models and run one inference each (backends may load lazily)."""
    embedder = build_embedder(settings)
    vector = embedder.embed_query("warm-up")
    if vector.shape != (embedder.dimensions,):
        raise SystemExit(f"embedder returned shape {vector.shape}, expected ({embedder.dimensions},)")
    print(f"embedder ready: {embedder.version}", flush=True)

    reranker = build_reranker(settings)
    if reranker is None:
        print("reranker disabled", flush=True)
        return
    scores = reranker.score("warm-up", ["a passage", "another passage"])
    if len(scores) != 2:
        raise SystemExit(f"reranker returned {len(scores)} scores for 2 passages")
    print(f"reranker ready: {reranker.backend}:{reranker.model}", flush=True)


def main() -> None:
    settings = Settings()
    if settings.model_cache_dir is None:
        raise SystemExit("PP_MODEL_CACHE_DIR must be set so the models land in a known directory.")

    if OFFLINE_FLAG in sys.argv[1:]:
        load_models(settings)
        return

    settings.model_cache_dir.mkdir(parents=True, exist_ok=True)
    load_models(settings)

    print("verifying that the models load without network access", flush=True)
    offline_env = {**os.environ, "HF_HUB_OFFLINE": "1"}
    subprocess.run([sys.executable, __file__, OFFLINE_FLAG], env=offline_env, check=True)  # noqa: S603
    print(f"models cached in {settings.model_cache_dir}", flush=True)


if __name__ == "__main__":
    main()
