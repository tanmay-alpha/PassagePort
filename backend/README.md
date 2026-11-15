# PassagePort backend

FastAPI service for document ingestion, hybrid retrieval, evidence-backed answers, document
comparison and the Search Lab. Python 3.12+, managed with [uv](https://docs.astral.sh/uv/).
Interactive API reference: `http://127.0.0.1:8000/api/docs` while the server runs.

## Run

```bash
uv sync --frozen --extra dev --extra postgres
uv run uvicorn passageport.main:app --host 127.0.0.1 --port 8000 --reload
```

Settings are `PP_*` environment variables (or a `backend/.env`); every one is documented in
[`../.env.example`](../.env.example). The defaults give single-user local mode with SQLite and
ONNX models downloaded on first use.

## Layout

| Package | Responsibility |
| --- | --- |
| `passageport/api/` | Routers, request/response schemas (`schemas.py` is the API contract), middleware, rate limit |
| `passageport/auth/` | Local mode and accounts mode: Argon2id, hashed server-side sessions, API tokens |
| `passageport/storage/` | Upload validation and original-file storage (filesystem or database) |
| `passageport/parsing/` | PDF, DOCX, Markdown and text parsers, run in a killable child process |
| `passageport/chunking.py` | Page-bounded semantic chunking with exact offsets and deterministic IDs |
| `passageport/ingest/` | Leased indexing jobs, heartbeat, fencing, atomic index swap |
| `passageport/search/` | Tokenizer, BM25, exact vector search, reciprocal-rank fusion, reranking, index cache |
| `passageport/answer/` | Extractive answers and optional, citation-checked LLM answers |
| `passageport/compare/` | Per-document evidence, alignment, text-computed differences |
| `passageport/lab/` | Stage-by-stage retrieval inspection |
| `passageport/evaluation/` | Metrics, datasets, evaluation CLI, bundled report |
| `passageport/db/` | SQLAlchemy Core schema and ownership-checked reads (SQLite or PostgreSQL) |
| `passageport/ml/` | Embedder and reranker backends (fastembed/ONNX, sentence-transformers, test hashing embedder) |

## Endpoints

All routes are under `/api`; errors are `{"error": {"code", "message"}}`.

| Area | Routes |
| --- | --- |
| System | `GET /health`, `GET /system`, `GET /session` |
| Auth (accounts mode) | `POST /auth/signup`, `/auth/login`, `/auth/guest`, `/auth/logout`; `GET, POST /auth/tokens`; `DELETE /auth/tokens/{id}` |
| Collections | `GET, POST /collections`; `GET, PATCH, DELETE /collections/{id}` |
| Documents | `GET, POST /collections/{id}/documents` (multipart `file`); `GET, PATCH, DELETE /documents/{id}`; `POST /documents/{id}/reindex`; `GET /documents/{id}/file`, `/outline`, `/pages/{n}` |
| Citations | `GET /chunks/{chunk_id}` |
| Retrieval | `POST /search`, `/ask`, `/compare`, `/lab/search`; `GET /lab/evaluation` |

Unsafe methods need the header `X-PassagePort-CSRF: 1` unless, in accounts mode, the request
carries a bearer API token.

## Tests and checks

```bash
PP_EMBEDDING_BACKEND=hashing PP_RERANKER_BACKEND=none uv run pytest
uv run ruff check . && uv run ruff format --check . && uv run mypy passageport
```

Tests use a deterministic hashing embedder, so they need no model download. To run the data-layer
tests against PostgreSQL, set `PP_TEST_DATABASE_URL` to a disposable database; each test gets its
own schema, which is dropped afterwards. Tests marked `models` use the real models and are
deselected by default (`uv run pytest -m models`).

## Evaluation

```bash
uv run python -m passageport.evaluation.run --help
```

Methodology, datasets and measured results: [`../docs/SEARCH_EVALUATION.md`](../docs/SEARCH_EVALUATION.md).
