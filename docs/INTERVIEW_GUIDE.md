# Interview guide

Use these as explanations to adapt, not claims to memorize. Code paths below are relative to `backend/passageport/`. Results belong in the evaluation report, not in an interview claim without its dataset and conditions.

## 0. Project pitches

### 30 seconds

“I built PassagePort, a document workspace rewritten from an MIT-licensed FastAPI/React knowledge-base project. Users upload documents, search with keywords and embeddings, and open passages on their source pages. I focused on trustworthy document lifecycle operations: transactional indexing, recoverable jobs, ownership checks, and citations tied to stored text. Answers work as quoted excerpts without an LLM; generated answers are optional and explicitly not fact-checked.”

### 2 minutes

“The starting project already had vector retrieval and reranking, but it stored chunks without a document lifecycle or page citations. I wanted a workspace where users could upload PDFs, manage documents, search exact identifiers as well as paraphrases, and inspect the evidence behind an answer.

“My main design decision was to keep metadata, pages, chunks, and embedding blobs in one SQL database. Indexing parses and embeds outside the write transaction, then swaps the document’s index atomically. Search builds a version-checked in-memory BM25 index and embedding matrix from SQL. This deliberately targets personal workspaces rather than internet-scale retrieval.

“I combine keyword and semantic candidate lists with reciprocal-rank fusion, then optionally rerank a bounded pool with a cross-encoder. Search Lab exposes the stages and settings; the evaluation harness runs the production retrieval path rather than a separate approximation.

“The harder backend work was failure handling and isolation. Jobs have leases, heartbeats, and attempt-based fencing so an old worker cannot overwrite a newer claim. Collection and document access is owner-scoped. A citation contains a page and exact offsets into stored text. Ask can quote evidence without a model; optional generation validates citation references but cannot prove that a sentence follows from its source. That distinction is part of the product, not hidden behind the word ‘grounded.’”

## 1. Why does semantic search differ from keyword search?

**Answer.** I use keyword retrieval to reward matching terms, including technical identifiers, with BM25’s rarity weighting, term-frequency saturation, and length normalization. I use semantic retrieval to compare learned representations, so differently worded passages can match a query. I normalize embeddings and compute cosine similarity with a matrix–vector product. I keep both because paraphrase matching and exact symbol matching solve different problems.

**Code:** `search/tokenize.py` — `tokens`, `_expand`; `search/bm25.py` — `BM25Index.scores`; `search/index.py` — `CollectionIndex.similarities`.

**Follow-ups**
- **How are identifiers handled?** Compounds and camelCase identifiers retain whole forms and emit parts; regular plurals are folded.
- **Does hashing demonstrate semantic quality?** No. `ml/hashing.py:HashingEmbedder` has no learned semantics; it exercises plumbing deterministically.

**Limitation / next:** English-oriented token normalization and the default English model need evaluation on other languages.

## 2. How are BM25 and vector retrieval combined?

**Answer.** I retrieve bounded candidate lists independently, then fuse their ranks rather than incomparable raw scores. I use exactly `RRF(d) = Σᵢ wᵢ / (rrf_k + rankᵢ(d))`, with one-based ranks and contributions only from lists containing the chunk. I default to equal weights and `rrf_k = 60`; ties resolve by chunk ID. I can inspect each stage separately rather than treating the fused score as a probability.

**Hand-worked example:** keyword ranks `[A, B]`, semantic ranks `[C, A]`, both weights `1`, and `k = 60`:
- `A = 1/61 + 1/62 = 123/3782 ≈ 0.032522`.
- `B = 1/62 ≈ 0.016129`; `C = 1/61 ≈ 0.016393`.
- Final order: `A, C, B`. These are illustrative calculations, not measured retrieval results.

**Code:** `search/fusion.py` — `weighted_rrf`; `search/service.py` — `retrieve`; `config.py` — `Settings`.

**Follow-ups**
- **Why not add BM25 and cosine?** Their magnitudes have different meanings; rank fusion avoids score calibration.
- **What does k change?** Larger k reduces the relative advantage of the first few ranks.

**Limitation / next:** RRF discards score margins; tune candidate depth and weights using held-out relevance judgments.

## 3. Why can reranking help?

**Answer.** I precompute passage embeddings with a bi-encoder, which encodes queries and passages independently. I optionally apply a cross-encoder that reads each query–passage pair jointly and can assess finer interactions. I restrict it to the top fused candidates because every pair needs model inference, unlike a reusable passage vector. I use its raw relevance scores for ordering and the configured confidence threshold, not as calibrated probabilities.

**Code:** `search/service.py` — `retrieve`, `is_relevant`; `ml/fastembed_backend.py` — `FastEmbedEmbedder`, `FastEmbedReranker.score`; `ml/st_backend.py` — `SentenceTransformerReranker.score`.

**Follow-ups**
- **Can it recover a missed passage?** No; it only scores the selected pool.
- **What happens outside that pool?** Candidates retain their previous order after the reranked pool; without a rerank score they do not establish confidence when reranking ran.

**Limitation / next:** Reranking adds latency and can hurt domain-specific queries; compare ablations before enabling it for a workload.

## 4. How does PDF chunking affect results?

**Answer.** I parse PDF pages separately and never let a chunk cross a page. I use semchunk with the embedding model’s own tokenizer and a configurable token budget, currently 256 tokens with no overlap by default. I prefer smaller passages for focused matches, while larger passages preserve context but can dilute relevance. I accept that page boundaries may split an explanation because reliable source-page citations are a deliberate constraint.

**Code:** `parsing/formats.py` — `parse_pdf`; `chunking.py` — `_spans`, `chunk_pages`; `ml/fastembed_backend.py` — `FastEmbedEmbedder.count_tokens`; `config.py` — `Settings`.

**Follow-ups**
- **Why not character counts?** Tokens control the model input budget more directly; the counting tokenizer disables truncation.
- **Why add overlap?** It can retain boundary context, but duplicates evidence and increases storage and embedding work.

**Limitation / next:** Extraction is not layout-aware; evaluate tables, columns, and adjacent-page context before changing boundaries.

## 5. How are citations mapped to source pages?

**Answer.** I store the normalized page text and form each chunk by slicing it. I preserve the invariant `page.text[char_start:char_end] == chunk.text`, using start-inclusive, end-exclusive offsets. I return document ID, page number, and offsets with each hit and numbered evidence reference. I derive chunk IDs from SHA-256 of `document_id|page_number|char_start|char_end|chunker_version`, taking the first 24 hexadecimal characters.

**Code:** `chunking.py` — `chunk_pages`, `chunk_id`, `chunker_version`; `ingest/pipeline.py` — `store_index`; `search/service.py` — `_hit_fields`, `Retrieval.evidence`.

**Follow-ups**
- **Are these PDF byte offsets?** No; they address the stored normalized text, not bytes or rendered coordinates.
- **Are links permanent?** Identical boundaries and version reproduce IDs; deletion or changed chunking can invalidate them.

**Limitation / next:** Text offsets do not guarantee a visual PDF highlight; layout coordinates would need separate extraction and validation.

## 6. How is retrieval performance evaluated?

**Answer.** I run labeled queries through the same `retrieve` function used by the application. I compare keyword, semantic, hybrid, and reranked configurations, keeping the relevance unit explicit: passages or deduplicated documents. I macro-average ranking metrics over answerable queries and report refusal behavior separately for out-of-scope questions. I use [SEARCH_EVALUATION.md](SEARCH_EVALUATION.md) and [`eval/`](../eval/) for measured numbers and conditions, not remembered headline scores.

- **Recall@K:** relevant items retrieved in the first K divided by all relevant items.
- **Precision@K:** relevant items in the first K divided by K, even if fewer results return.
- **MRR:** mean reciprocal rank of the first relevant result, or zero when absent; this harness truncates at ten results.
- **nDCG@K:** relevance gains discounted by `log₂(rank + 1)`, divided by ideal DCG; this implementation uses binary gains.

Measured with the default CPU models (`eval/results/default.json`; mini = 58 answerable self-authored queries over 14 documents, SciFact = first 50 test queries, document-level relevance). Timings are from a shared Windows workstation, so treat them as indicative.

| Corpus | Pipeline | Recall@1 | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | p50 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mini | keyword | 0.629 | 0.741 | 0.776 | 0.678 | 0.702 | 0.7 |
| mini | semantic | 0.560 | 0.776 | 0.862 | 0.652 | 0.702 | 5.6 |
| mini | hybrid | 0.595 | 0.845 | 0.862 | 0.698 | 0.738 | 5.3 |
| mini | hybrid+rerank | 0.716 | 0.828 | 0.914 | 0.771 | 0.804 | 598.1 |
| scifact | keyword | 0.600 | 0.790 | 0.834 | 0.701 | 0.731 | 1.1 |
| scifact | semantic | 0.729 | 0.851 | 0.886 | 0.806 | 0.819 | 8.5 |
| scifact | hybrid | 0.669 | 0.838 | 0.913 | 0.787 | 0.808 | 9.6 |
| scifact | hybrid+rerank | 0.615 | 0.863 | 0.926 | 0.750 | 0.791 | 616.2 |

Honest reading: on the self-authored mini set, hybrid and reranking help most (paraphrase queries are where keyword search fails). On the external SciFact subset, vector search alone has the best top-rank metrics and reranking *lowers* MRR while improving Recall@10, so reranking is a switch, not a free upgrade. Full methodology: [SEARCH_EVALUATION.md](SEARCH_EVALUATION.md).

**Code:** `evaluation/metrics.py` — `recall_at_k`, `precision_at_k`, `reciprocal_rank`, `ndcg_at_k`; `evaluation/harness.py` — `run_queries`, `summarize`; `evaluation/run.py` — `cmd_evaluate`.

**Follow-ups**
- **Does latency include cold loading?** The evaluation command warms query caches first; inspect model-load and indexing records separately.
- **Why multiple metrics?** Recall measures coverage; precision and rank-sensitive metrics measure usefulness near the top.

**Limitation / next:** Corpus-specific labels do not establish universal quality; add held-out domains and independently reviewed judgments.

## 7. Why these models and this database?

**Answer.** I chose ONNX `BAAI/bge-small-en-v1.5` embeddings and the MiniLM `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder as CPU-first defaults without PyTorch. I retain upstream’s multilingual gte models through the optional sentence-transformers backend rather than claiming the smaller English default wins everywhere. I keep metadata and vectors in SQL so document replacement is transactional, then use in-process exact search instead of upstream’s LanceDB store. I target personal collections around the architecture’s 50k-chunk design target, not a measured capacity guarantee: matrices, text, and postings consume RAM per process, and exact scans and sorting grow with collection size.

**Code:** `config.py` — `Settings`; `ml/registry.py` — `build_embedder`, `build_reranker`; `ml/st_backend.py` — `_trusts_remote_code`; `search/index.py` — `CollectionIndex.semantic`; `ingest/pipeline.py` — `store_index`.

**Follow-ups**
- **Why not always multilingual?** Language coverage trades against deployment footprint and workload-specific cost; benchmark the actual corpus.
- **Does PostgreSQL accelerate vector search here?** No. It persists embedding blobs; NumPy performs retrieval.

**Limitation / next:** The cache limits collection count, not memory bytes; establish resource budgets before scaling.

## 8. What happens when indexing fails?

**Answer.** I persist jobs in SQL and claim work with a conditional update that increments an attempt counter. I renew a lease through heartbeats; an expired claim becomes eligible for another worker. I use that attempt number as a fencing token before status writes and the final index transaction, so a superseded worker cannot publish stale work. I mark first-time deterministic failures as failed, but preserve an existing index and record an error when re-indexing fails; transient errors retry only up to the configured limit.

**Code:** `ingest/worker.py` — `claim_next`, `ClaimedJob.renew`, `ClaimedJob.finish`, `process_job`; `ingest/pipeline.py` — `index_document`, `record_failure`.

**Follow-ups**
- **Is execution exactly once?** No; attempts can repeat computation, while fencing protects publication.
- **Does parsing hold a DB transaction?** No. Parsing, chunking, and embedding happen before the final swap transaction.

**Limitation / next:** One worker thread runs jobs serially per process; add queue observability and controlled worker capacity before expanding throughput.

## 9. How do persistence and data isolation work?

**Answer.** I enforce ownership before retrieval and scope document and chunk reads by owner, returning the same 404 for foreign and missing IDs. I store random session secrets only as hashes, check expiry server-side, and rotate the presented session on login. I validate cached indexes against collection `index_version` and embedding version on use, with chunk mutations and version increments committed together. I support local SQLite with persistent files, while the hosted shape uses accounts mode, PostgreSQL, and database-backed originals so container-local state is disposable.

**Code:** `db/access.py` — `require_collection`, `require_documents`, `get_chunk_for_user`; `auth/service.py` — `_create_session`, `authenticate_request`, `login`; `search/index.py` — `IndexCache.get`; `db/engine.py` — `create_db_engine`; `db/schema.py` — table declarations.

**Follow-ups**
- **Are cache entries authorization checks?** No. `retrieve` checks collection ownership before accessing the cache.
- **What if the embedding model changes?** Different embedding versions are excluded and reported as stale until re-indexed.

**Limitation / next:** Application-level isolation is not database row-level security; add defense-in-depth policies and migration tooling for larger deployments.

## 10. What is genuinely new compared with upstream?

**Answer.** I describe this as a rewrite of an existing project, not a new invention of retrieval. I retained the FastAPI/React/Vite foundation, semchunk chunking idea, retrieve-then-rerank idea, optional upstream models, and MCP server concept identified in [BASELINE_AUDIT.md](BASELINE_AUDIT.md). I added document identity and lifecycle operations, PDF/DOCX parsing, page-and-offset citations, BM25/RRF hybrid retrieval, recoverable indexing jobs, and accounts-based isolation. I also added evidence-oriented Ask and computed document comparison rather than presenting every similarity as an LLM conclusion.

**Code:** `parsing/formats.py` — `parse_pdf`, `parse_docx`; `ingest/pipeline.py` — `store_index`; `search/service.py` — `retrieve`; `answer/service.py` — `run_ask`; `compare/service.py` — `run_compare`; `compare/align.py` — `diff_passages`.

**Follow-ups**
- **Was reranking your contribution?** No; upstream already retrieved then reranked. Hybrid candidate generation and lifecycle correctness are distinct changes.
- **Is Compare semantic fact-checking?** No. It aligns retrieved passages and computes text/value differences; optional model interpretation is separate.

**Limitation / next:** Feature breadth is not evidence of reliability; defend each improvement with its implementation and appropriate evaluation.

## Hard questions

1. **Why not pgvector or FAISS now?** SQL plus exact search keeps transactions and deployment simple at this scope. pgvector offers database-integrated ANN; FAISS adds a separate index lifecycle to reconcile with SQL.
2. **How would this handle 10M chunks?** Not with the current per-process full matrix. Partition tenants, introduce ANN and bounded candidate retrieval, separate workers, and measure recall and memory before selecting infrastructure.
3. **How do you know an LLM answer is grounded?** `answer/prompt.py:parse_cited_answer` validates reference membership, not entailment. Unsupported sentences are flagged; failed or wholly uncited output falls back to excerpts. A valid citation can still support a false interpretation.
4. **What are RRF’s failure modes?** It loses score margins, depends on candidate depth, and can promote consensus between correlated weak retrievers. Reranking cannot fix passages excluded by both lists.
5. **Can queue workers race?** Yes, especially after lease expiry. Conditional claims and attempt-based final fences prevent competing claims from both publishing; duplicate computation remains possible.
6. **Why argon2id for passwords but SHA-256 for sessions?** Passwords have low entropy and need expensive memory-hard hashing (`auth/passwords.py:hash_password`). Random session secrets already resist guessing; a fast hash avoids storing bearer credentials in plaintext.
7. **What exactly is the CSRF design?** `api/middleware.py:CsrfMiddleware.__call__` requires a custom header and checks supplied origins. Accounts-mode bearer requests are exempt but cannot fall back to cookies. Origin checking allows configured origins and compares authority for proxy compatibility; deployment trust still matters.
8. **Are parser subprocesses a security sandbox?** They contain timeouts and crashes, not arbitrary code execution privileges. `parsing/isolated.py:run_isolated` kills overdue children; OS isolation would be stronger.
9. **Does a cache version make reads linearizable?** No. It validates against the database state visible to the request; a concurrent commit can race with an in-flight query. It avoids relying on cross-process invalidation messages.
10. **Can confidence thresholds guarantee correctness?** No. `search/service.py:is_relevant` applies configured score/coverage rules, not a proof. Model and domain changes require recalibration and explicit false-accept/refusal measurement.

## System design extensions

- **Multi-tenant scale-out:** Keep ownership checks mandatory; use shared PostgreSQL, independently scaled ingest workers, distributed rate limits, queue monitoring, and byte-budgeted per-process caches. Design tenant fairness before simply adding workers.
- **ANN index:** Replace the exact-search seam in `search/index.py`, retaining embedding-version checks and authorization filters. Publish index generations safely and measure ANN candidate recall against today’s exact reference.
- **OCR:** Add an explicit OCR stage for image-only pages, preserve page numbering, and store extraction provenance and coordinates. Report partial failures rather than silently treating unreadable pages as empty evidence.
- **Streaming:** Stream optional generation through a cancellable API, but keep tokens provisional until citation parsing completes. Final structured segments must retain unsupported flags; partial text must not imply verified claims.

## Resume bullets

- Built PassagePort, a document search and cited-answer app with hybrid BM25 + vector + RRF retrieval and cross-encoder reranking; measured on a self-authored mini corpus (hybrid+rerank MRR@10 0.771, nDCG@10 0.8044) and a 50-query BEIR SciFact subset (Recall@10 0.926), reporting where reranking lowers SciFact MRR (0.7498 vs 0.7872 hybrid).
- Engineered page-accurate citations with a property-tested offset invariant and lease-based, crash-safe indexing with fencing; fixed findings from independent security audits (ZIP preflight, quota row locking, atomic login throttle, fenced workers, transactional DB blobs, guest purge).
- Shipped with 547 backend tests (also run against real PostgreSQL 17: 228 passed, 1 skipped), 75 frontend tests and 3 Playwright projects (Chromium, mobile Chromium, Firefox) covering upload → index → search → cited PDF page → compare → restart persistence and account isolation; deployed on Vercel + Neon PostgreSQL (https://passageport.vercel.app) with a non-root Docker image verified with offline models.

Every claim above is reproducible from the commands in the [README](../README.md) (Measured results and Verification commands).
