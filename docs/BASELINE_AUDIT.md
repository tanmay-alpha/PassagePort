# Baseline audit of `praveenc/simple-knowledge-base`

Audited commit: `a0d8c06` (2025-12-26, 29 commits, single author Praveen Chamarthi, MIT).
Audit date: 2026-11-13. Environment: Windows 11, i7-14650HX (24 threads), 16 GB RAM, CPU only.

## What upstream is

| Layer | Implementation |
| --- | --- |
| Backend | FastAPI, one `main.py` (788 lines) + `services.py` (667 lines), Python ≥ 3.13 |
| Storage | LanceDB only; one table per "index"; rows = chunks (`content`, 768-d vector, `source_document` string, `chunk_offset`) |
| Chunking | `semchunk` with the embedding tokenizer, 512 tokens |
| Models | `Alibaba-NLP/gte-multilingual-base` embeddings + `gte-multilingual-reranker-base`, PyTorch via sentence-transformers, `trust_remote_code=True` |
| Search | vector top-20 → cross-encoder rerank → top-k |
| Ingestion | upload of `.md`/`.txt`; server-side file path; server-side directory batch; llms.txt URL crawler |
| Frontend | React 19 + Vite + AWS Cloudscape; three tabs (search, add knowledge, manage indexes) |
| MCP | TypeScript server exposing list/search/"fetch doc" |
| Tests | 75 pytest tests (API, models, services, Hypothesis properties); no frontend or E2E tests; no CI |

## Measured baseline

| Check | Result |
| --- | --- |
| `uv sync --extra dev` + `pytest -q` (backend) | **75 passed** in 593.9 s (first run, includes downloading both models) |
| Model download | 1.2 GB (`gte-multilingual-base`) + 1.2 GB (`gte-multilingual-reranker-base`) in the Hugging Face cache |
| Backend virtualenv | 1.1 GB (PyTorch CPU build, Windows) |
| App start → first upload (1 KB Markdown, model load included) | 7.6 s |
| First query (reranker load included) | 4.4 s |
| Warm query, 2 chunks in the index | 0.26 s |
| `POST /encode_doc` with the path of a file outside the project | accepted; the file's text is returned by the next query (finding S1) |
| CORS preflight from `https://evil.example` | `access-control-allow-origin: https://evil.example`, `allow-credentials: true` (finding S4) |

Screenshots of the upstream UI are in [`screenshots/before/`](screenshots/before/).

Frontend: `npm ci && npm run build` succeeds (JS 795 kB / 226 kB gzip, CSS 812 kB / 207 kB gzip, single
chunk, Vite size warning). `npm run lint` passes. `npm audit`: 16 advisories (12 high) in the
lockfile. MCP server: `tsc --noEmit` passes.

Retrieval quality and latency of the upstream pipeline are measured with the same harness as the new
pipeline; see [SEARCH_EVALUATION.md](SEARCH_EVALUATION.md).

## Findings

Severity: P0 = security/data-loss/correctness, P1 = core product gap, P2 = quality, P3 = nice to have.

### P0

| # | Finding | Evidence | Acceptance criterion |
| --- | --- | --- | --- |
| S1 | **Arbitrary server-side file read.** `POST /encode_doc` reads any path the caller names and indexes it; search then returns its content. | `main.py` `encode_document` → `services.read_document(Path(file_path))`, no allowlist | No endpoint accepts a server path |
| S2 | **Arbitrary directory crawl.** `POST /encode_batch` recursively globs any directory, default patterns include `*.py`, `*.json`. | `services.discover_documents` → `path.rglob(pattern)` | Removed |
| S3 | **SSRF.** `POST /ingest_llms_txt` fetches any URL and every link inside it, following redirects, from the server. | `LLMSTxtScraper.fetch_url`, `follow_redirects=True`, no host filtering | Removed |
| S4 | **No authentication, wildcard CORS with credentials.** Any web page the user visits can call the local API (including S1–S3) cross-origin. | `allow_origins=["*"], allow_credentials=True` | Local mode restricted to loopback hosts + CSRF header; accounts mode for anything exposed |
| S5 | **Remote code from model repos.** `trust_remote_code=True` for both models executes Python shipped in the model repository. | `services.py` `ModelManager` | Default models need no remote code; allowlist for the optional upstream models |
| S6 | **No upload limits.** `await file.read()` loads the whole body; no size cap; only the extension is checked. | `main.py` `upload_document` | Streaming size cap, content sniffing, per-user quotas |
| D1 | **No document identity.** Chunks carry only a `source_document` string. Documents cannot be listed, deleted or replaced; uploading the same file twice duplicates every chunk; the original file is discarded. | `database.add_chunks`; no delete-by-document anywhere | Document records, sha256 dedup, delete and re-index |
| D2 | **Silent failure of background work.** Batch and llms.txt ingestion are fire-and-forget `asyncio.create_task`; exceptions are logged and lost; the UI infers progress by polling the row count. | `_process_batch_async`, `AddKnowledge.tsx` | Persistent jobs with status and error on the document |
| D3 | **Event-loop blocking.** Embedding and reranking run synchronously inside `async def` handlers, freezing every other request (including `/health`) during indexing. | `async def query`, `async def upload_document` | Blocking work off the event loop |
| D4 | **Embedding dimension hard-coded** in the table schema (`Vector(768)`); changing the model corrupts or breaks the index with no versioning. | `models.ChunkSchema` | Embedding version stored per chunk; stale documents detected |

### P1

| # | Finding | Evidence | Acceptance criterion |
| --- | --- | --- | --- |
| R1 | **Vector-only retrieval.** Exact identifiers, error codes and numbers that the embedding model blurs are missed; the reranker can only reorder what the vector stage returned. | `query` handler | BM25 + vector + fusion, measured |
| R2 | **No citations.** Results show a filename and a character offset; there are no pages and nothing to open. | `SearchResult` | Page/section references that open the source |
| R3 | **No PDF/DOCX support.** | `ALLOWED_EXTENSIONS = {".md", ".txt"}` | PDF, DOCX parsing |
| R4 | **No empty/low-confidence handling.** The reranker always returns top-k, however irrelevant. | `query` handler | Confidence gating and explicit notices |
| R5 | **Heavy models.** 2.4 GB of model weights plus a 1.1 GB PyTorch environment for a local single-user tool; multi-second cold start. | measured below / SEARCH_EVALUATION.md | CPU-light default, heavy optional |
| U1 | **UI exposes implementation, not workflow.** "Indexes", absolute server paths typed into a text box, raw relevance scores; no document list, no preview, no dark mode toggle, console-style AWS look. | `AddKnowledge.tsx` (741 lines), screenshots in upstream README | Workflow-first UI |
| M1 | **MCP "fetch document" is a search in disguise.** `kb_fetch_doc` queries with the filename as the query text and filters the top-k by substring. | `mcp-server/src/tools.ts` | Real page/passage retrieval by ID |

### P2

| # | Finding | Evidence |
| --- | --- | --- |
| Q1 | No CI, no Docker image, no lint/type configuration committed for the backend (ruff referenced only in editor rules). | repository tree |
| Q2 | Tests share a global DB path and clean up by name prefix (`test*`), so a real index named `test…` in `./data` is deleted by running the suite. | `tests/conftest.py` `cleanup_test_indexes` |
| Q3 | Two lockfiles for the frontend (`package-lock.json`, `pnpm-lock.yaml`). | repository tree |
| Q4 | `ValueError` is mapped globally to HTTP 400 and echoed, so internal errors can leak messages. | `value_error_handler` |
| Q5 | Requires Python ≥ 3.13 only for PEP 695 `type` aliases. | `pyproject.toml` |
| Q6 | 1.6 MB of JS+CSS in one chunk for three forms. | build output |

### P3

Editor-specific rule folders (`.kiro`, `.windsurf`) in the repo root; README badges without CI.

## What is worth keeping

- The overall shape: FastAPI + typed Pydantic models + a React/Vite/TypeScript client.
- `semchunk` for token-bounded semantic chunking (kept, now page-aware with exact offsets).
- The retrieve-then-rerank idea (kept as an optional final stage).
- The upstream models as an optional, benchmarked backend.
- The MCP server as an integration surface (rewritten against the new API).
- Hypothesis-style property tests for chunking invariants (the idea is kept; tests are new).
