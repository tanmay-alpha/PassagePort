# Notice

## Origin

PassagePort is a derivative work of
[praveenc/simple-knowledge-base](https://github.com/praveenc/simple-knowledge-base),
created by Praveen Chamarthi and published under the MIT License
(`Copyright (c) 2025 simple-knowledge-base`).

- Upstream commit this project started from:
  `a0d8c0633209e5965c8e1894641cb40f0849f847` (`a0d8c06`, 2025-12-26).
- The upstream history is preserved in this repository's git history.
- PassagePort keeps upstream's product idea (upload documents, index them, search them from a
  web UI and from an MCP server) and its repository layout (`backend/`, `frontend/`,
  `mcp-server/`). The backend, the web client and the MCP server were rewritten for PassagePort;
  see the git history for exactly what changed.
- Retained technical foundations, as listed in [`docs/BASELINE_AUDIT.md`](docs/BASELINE_AUDIT.md):
  FastAPI with Pydantic models, a React/Vite/TypeScript client, `semchunk` token-bounded
  chunking, the retrieve-then-rerank pattern, upstream's gte-multilingual models as an optional
  backend, the MCP server as an integration surface, and the idea of property-testing chunking.

## License

The whole repository is distributed under the MIT License in [`LICENSE`](LICENSE). That file
keeps the upstream copyright line unchanged and adds a second line for the PassagePort
modifications:

```
Copyright (c) 2025 simple-knowledge-base
Copyright (c) 2026 Tanmay Mangal
```

Redistributions must keep both lines together with the license text.

## Models

PassagePort does not contain model weights in this repository. Models are downloaded from the
Hugging Face Hub at first use, or at image build time when the Docker image is built with
`PRELOAD_MODELS=1`. **Such an image contains copies of the two default models**, so whoever
distributes it must also comply with the model licenses below.

The licenses were read from the Hugging Face model metadata on 2026-11-13. Model cards can
change; check them before you redistribute a model or an image that includes one.

| Model | Used for | License |
|-------|----------|---------|
| [`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) | Default embedding model. fastembed downloads the ONNX export [`Qdrant/bge-small-en-v1.5-onnx-Q`](https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q). | MIT (both repositories) |
| [`Xenova/ms-marco-MiniLM-L-6-v2`](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2) | Default reranker (cross-encoder, ONNX). | See model card: the Xenova repository declares no license of its own. It is an ONNX conversion of [`cross-encoder/ms-marco-MiniLM-L6-v2`](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2), which is Apache-2.0, and fastembed lists the model as Apache-2.0. |
| [`Alibaba-NLP/gte-multilingual-base`](https://huggingface.co/Alibaba-NLP/gte-multilingual-base) | Optional embedding model (upstream's default), `sentence-transformers` backend. Never downloaded unless configured. | Apache-2.0 |
| [`Alibaba-NLP/gte-multilingual-reranker-base`](https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base) | Optional reranker (upstream's default), `sentence-transformers` backend. Never downloaded unless configured. | Apache-2.0 |

Any other model selected through `PP_EMBEDDING_MODEL` / `PP_RERANKER_MODEL` comes with its own
license; check its model card.

## Evaluation data

The evaluation harness can download public retrieval benchmarks into `eval/.cache/`. That
directory is not committed and the corpora are not redistributed with PassagePort; each
dataset has its own terms, which apply when you reuse it.

## Third-party software

PassagePort depends on open-source packages that remain under their own licenses. The exact
versions are pinned in `backend/uv.lock`, `frontend/package-lock.json`,
`mcp-server/package-lock.json` and `e2e/package-lock.json`; each package's license is available
from its distribution metadata. None of them is vendored into this repository.
