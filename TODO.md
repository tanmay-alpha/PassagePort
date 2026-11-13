# TODO

Status of the plan in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). Updated as work lands.

## Open

- [ ] OCR for scanned PDFs (currently rejected with a clear message)
- [ ] ANN / pgvector backend behind `search/index.py` for collections beyond ~50k chunks
- [ ] Streaming LLM answers
- [ ] Sharing collections between accounts
- [ ] Multilingual default embedding model (available today via `PP_EMBEDDING_BACKEND=sentence-transformers`)
