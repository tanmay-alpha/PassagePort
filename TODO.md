# TODO

Status of the plan in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). Updated as work lands.

## Open

- [ ] OCR for scanned PDFs (currently rejected with a clear message)
- [ ] ANN / pgvector backend behind `search/index.py` for collections beyond ~50k chunks
- [ ] Streaming LLM answers
- [ ] Sharing collections between accounts
- [ ] Multilingual default embedding model (available today via `PP_EMBEDDING_BACKEND=sentence-transformers`)

## Done

P0–P2 of the plan (items 1–17):

- [x] Uploads only: server-path and URL ingestion removed
- [x] SQL document model (collections → documents → pages → chunks) with original files kept
- [x] Upload validation: size caps, content sniffing, ZIP preflight, sha256 dedup
- [x] Parsing in a killable subprocess (PDF/TXT/MD/DOCX)
- [x] Lease-based background indexing with fencing and crash recovery
- [x] Auth boundary: loopback-only `local` mode; `accounts` mode with sessions and per-user isolation
- [x] Page-accurate citations with stable chunk IDs (property-tested offset invariant)
- [x] Hybrid BM25 + vector + RRF retrieval with optional cross-encoder reranking and confidence gating
- [x] Model comparison against upstream gte-multilingual ([SEARCH_EVALUATION.md](docs/SEARCH_EVALUATION.md))
- [x] Ask: extractive answers and LLM answers with citation validation
- [x] Compare: per-document evidence, alignment, computed differences
- [x] Search Lab with per-stage rankings and evaluation report
- [x] New UI with component tests and Playwright flows (Chromium, mobile Chromium, Firefox)
- [x] Docker image (offline models, non-root) and CI (lint, types, tests, PostgreSQL, E2E, image smoke, audits)
- [x] Hosted deployment on Vercel + Neon PostgreSQL: https://passageport.vercel.app
- [x] MCP server updated for the new API
- [x] README, walkthrough, security, deployment and interview docs
