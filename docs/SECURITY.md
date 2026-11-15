# Security model

PassagePort stores documents that may be confidential. This page states what is protected, how,
and what is not. Controls listed here are covered by tests in `backend/tests/` (named in the last
column) and by the end-to-end suite.

## Deployment modes and trust boundaries

| Mode | Who can reach the data | Boundary enforced by |
| --- | --- | --- |
| `PP_AUTH_MODE=local` (default) | Anyone who can open the app on the machine it runs on. There is no login. | Requests are only served when the `Host` header is a loopback name (`PP_LOCAL_ALLOWED_HOSTS`); the Docker Compose file publishes the port on `127.0.0.1` only; state-changing requests need a custom header that cross-site pages cannot send. |
| `PP_AUTH_MODE=accounts` | Signed-in users, each limited to their own collections. | Server-side sessions; every query is scoped by owner; rows of other users are reported as 404. |

Local mode must never be exposed to a network. To host PassagePort for anyone but yourself, use
accounts mode behind HTTPS.

## Threats and controls

| Threat | Control | Tests |
| --- | --- | --- |
| Arbitrary server-side file read (upstream `/encode_doc`, `/encode_batch`) | Endpoints removed. Documents enter only through multipart upload. Stored files are addressed by server-generated IDs; a client-supplied filename is display text only. | `test_uploads.py`, `test_security.py` (unknown API paths are JSON 404s) |
| SSRF (upstream `/ingest_llms_txt`) | Endpoint removed. The server makes outbound requests only to the configured LLM endpoint and to download models on first use (none when they are baked into the image). | — |
| Path traversal, unsafe filenames | Filenames are reduced to a sanitized basename; blob keys never contain user input; the static file handler resolves paths inside the build directory only. | `test_security.py`, `test_uploads.py` |
| Content-type spoofing, unsupported formats | Extension allowlist **and** content sniffing: `%PDF-` header, DOCX must be a ZIP containing `word/document.xml`, text must be valid UTF-8 without NUL bytes. The client's `Content-Type` is ignored. | `test_uploads.py` |
| Oversized uploads, decompression bombs | Uploads are read in bounded chunks and rejected past `PP_MAX_UPLOAD_MB`; DOCX EOCD and central-directory byte/count bounds are checked **before** `ZipFile` can allocate entry objects, then uncompressed-size caps are checked before extraction. ZIP64 and split archives are rejected. Page and character caps also bound parsing. | `test_uploads.py`, `test_parsing.py` |
| Malformed or malicious PDFs | Parsing runs in a separate process that is killed after `PP_PARSE_TIMEOUT_SECONDS` (with an address-space limit on POSIX). A crash or hang fails that one document with a readable message; the server keeps running and the original file is kept. | `test_parsing.py`, `test_jobs.py` |
| XSS / HTML injection from document text or model output | The UI renders passages, answers and filenames as text (React escaping; no `dangerouslySetInnerHTML`, no Markdown-to-HTML). Original files are served with a fixed `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, and as attachments unless they are PDFs (served inline). The app itself is served with a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, no inline or third-party script, `frame-ancestors 'none'`); only the Swagger page `/api/docs` gets a separate policy that allows its CDN assets and inline bootstrap. | `test_security.py`, frontend tests |
| Unauthorized access, cross-user leakage | Accounts mode: argon2id password hashes; random 256-bit session tokens stored only as SHA-256; `HttpOnly`, `SameSite=Lax` cookies, `Secure` unless `PP_COOKIE_SECURE=false`; sessions expire server-side and are rotated on login. Every repository query filters by owner. Search indexes are per collection and a request can only name collections and documents it owns. | `test_auth.py`, `test_isolation.py`, `test_search.py` |
| CSRF, DNS rebinding | State-changing requests must carry `X-PassagePort-CSRF: 1` and, when an `Origin` header is present, it must be the server's own host, a configured `PP_CORS_ORIGINS` entry, or (local mode only) another port on a loopback host. Accounts-mode requests with a bearer token are exempt and never fall back to the cookie. Local mode additionally rejects non-loopback `Host` headers. CORS is off unless origins are listed explicitly. | `test_security.py` |
| Credential stuffing | Login attempts reserve username and client-address throttle slots atomically **before** Argon2 verification, including concurrent requests; failures return one generic message; unknown usernames perform password verification against a dummy hash. At most two Argon2 computations (64 MiB each) run at once per process, so a burst of attempts queues instead of exhausting memory. | `test_auth.py`, `test_abuse.py` |
| Throttle evasion via client addresses | Throttles key on `request.client`: the TCP peer, or the `X-Forwarded-For` client when uvicorn runs with `--proxy-headers` (the Docker image does) and the peer is listed in `FORWARDED_ALLOW_IPS` (default `127.0.0.1`). The app never reads forwarding headers itself, so a client cannot choose its own key. IPv6 clients are keyed per /64, which one subscriber typically controls. | `test_abuse.py` |
| Anonymous account flooding, filling the database | Sign-up and guest creation share a per-address throttle (10 per 10 minutes). At most `PP_MAX_GUESTS` (default 100) guest accounts exist at once, counted in the database under a lock (a PostgreSQL advisory lock, SQLite's write lock), so concurrent requests and multiple instances cannot overrun it. `PP_MAX_DATABASE_MB` sets a server-wide ceiling on the database size: uploads are refused with 507 once it is reached, and the size is checked again right before each index is written, because extracted text can be many times the file size. | `test_abuse.py` |
| Resource exhaustion (CPU, memory, response size) | Compute-heavy endpoints are rate-limited per user (idle users are dropped from the table); query length is capped by `PP_MAX_QUERY_CHARS`, and `top_k`, candidates, compared documents (2–4) and document filters (at most 1,000 ids) are bounded by the request schemas; one indexing job runs at a time per process. Chunks are capped at `chunk_max_tokens × 16` characters even when the tokenizer counts a long run as one token, which bounds every passage in responses and in answer/compare processing. Sentence splitting is linear-time, and sentence matching in Compare has a fixed work budget per aligned group. The in-memory index cache holds at most 16 collections and 100,000 chunks (the most recently used index is kept even when it alone is larger). | `test_search.py`, `test_abuse.py` |
| Concurrent quota bypass | Upload document/storage quotas, the collection limit (`PP_MAX_COLLECTIONS_PER_USER`, default 100), and the API-token limit (20) are checked under a per-user database row lock. SQLite uses its write lock instead. Concurrent instances therefore cannot independently spend the same remaining quota. | `test_uploads.py`, `test_collections.py`, `test_auth.py` |
| Stale indexing workers | The claimed attempt fences every worker mutation: the initial `processing` status, retries, failures, and the transaction that replaces the index. A worker resuming after a successor completed cannot change the document or its index. | `test_jobs.py` |
| Blob/document lifecycle races | Database blobs are created and deleted in their document transaction. Collection and guest deletion lock the owner before collecting blob keys, so an in-flight upload cannot leave stored bytes behind. The DB orphan sweep deletes only rows without a document reference in the same SQL statement. | `test_persistence.py` |
| Prompt injection from document content | Passages are sent to the LLM as numbered, delimited quotations with delimiter look-alikes neutralized, under a system instruction that they are data. The model has no tools and cannot trigger requests. Its output is treated as untrusted text: citations that do not match a retrieved passage are dropped, uncited sentences are flagged, and it is rendered as plain text. | `test_ask.py`, `test_llm.py` |
| Leaking document text or credentials in logs and errors | Logs contain IDs, counts and exception types, not document text, queries, passwords or keys. API errors use fixed messages; unhandled exceptions return a generic 500. `/api/system` exposes model names and limits, never keys, URLs or paths. | `test_security.py`, `test_llm.py` |
| Remote code via model repositories | Default models are ONNX files run by ONNX Runtime; no repository code is executed. The optional PyTorch backend enables `trust_remote_code` only for the two upstream `Alibaba-NLP/gte-multilingual-*` models, which require it. | — |

## What an LLM provider sees

Nothing, unless you configure one. With `PP_LLM_BASE_URL` set, the question and the text of the
top retrieved passages (not whole documents) are sent to that endpoint for Ask and for the optional
interpretation in Compare. Point it at a local server (for example Ollama) to keep everything on
your machine.

## Known limitations

- **Not encrypted at rest.** Files and the database are stored as-is; use disk encryption.
- **Compute rate limits and credential throttles are per process and in memory.** Multiple server
  processes do not share these counters, and the compute rate limit is per account, so many
  accounts can still keep a small instance busy. Document, storage, collection, API-token and guest
  limits and the database ceiling are database-serialized and do apply across processes sharing the
  same database.
- **Client addresses are only as good as the proxy configuration.** Behind a reverse proxy set
  `FORWARDED_ALLOW_IPS` to that proxy's address, and only when it overwrites (not appends to)
  `X-Forwarded-For` or is the only way to reach the server. Without it, every client appears as
  the proxy and shares one throttle.
- **The database ceiling is shared and approximate.** One account can use all remaining room, after
  which nobody can upload until data is deleted (guest data expires with its guests). Concurrent
  indexing workers can each overshoot it by one document's index. Per-user storage quotas count
  file bytes; extracted text (bounded per document by `PP_MAX_DOCUMENT_CHARS`) comes on top.
- **Indexing is first come, first served.** One account can queue up to its document quota and keep
  the single worker of a process busy; each job is bounded by `PP_PARSE_TIMEOUT_SECONDS` plus
  embedding time.
- **The guest cap trades availability for storage.** Someone rotating addresses can hold all
  `PP_MAX_GUESTS` slots until those guests expire; registered accounts keep working.
- **Older oversized chunks** (stored before the chunk character cap) keep their size until the
  document is re-indexed; sentence splitting and Compare stay bounded for them.
- **Filesystem blobs cannot join SQL transactions.** Failed uploads remove their files; deletion
  unlinks files after commit. A startup sweep removes crash leftovers older than one hour.
  The database blob backend has transactional creation/deletion instead.
- **No malware scanning** of uploads. Files are parsed, never executed, and served back with
  sandboxing headers.
- **The parser sandbox is a process boundary, not a container.** It contains hangs and crashes; a
  parser vulnerability that achieves code execution would run with the server's privileges.
- **Generated answers are not fact-checked.** The UI states what was checked (citations resolve to
  retrieved passages) and what was not.
- **Scanned PDFs are rejected** (no OCR), so nothing is silently indexed as empty.
- **Guest accounts** (if enabled) are isolated like normal accounts. Expired guests and their data
  are purged on startup, guest creation, and every ten minutes between indexing jobs in thread
  mode. Cleanup can be delayed by an in-flight indexing job. Manual job mode has no periodic worker.

## Audit verification (2026-11-15, public guest-enabled deployment)

The audit assumed the hosted shape: accounts mode, open sign-up and guests, PostgreSQL with
database blobs, one container behind Vercel's proxy. Tests ran with the hashing embedder and no
reranker; they do not measure production model quality or replace a penetration test.

- **Client addresses on Vercel (observed):** the container's uvicorn logged the real client
  address with port 0 (rewritten from `X-Forwarded-For` by `--proxy-headers`, so Vercel's proxy
  connects from `127.0.0.1`), and a client-supplied `X-Forwarded-For` was replaced by Vercel, not
  passed through. `FORWARDED_ALLOW_IPS` therefore needs no setting there.
- **Measured before the fixes:** splitting 60,000 `!` characters into sentences took 51 s, a
  60,000-character word before a detached period 30 s, and diffing two near-identical
  20,000-character sentences 54 s; a Compare request over two such stored passages took 50 s; a
  40,000-id document filter produced a 500. After: all 24 tests of `test_abuse.py` run in about 3 s.
- **SQLite:** the whole backend suite, 571 passed in 77 seconds. The 24 new tests in
  `test_abuse.py` were also run against the previous code: 21 failed (the 3 that passed guard
  behaviour that was already correct).
- **Real PostgreSQL 16.15:** abuse, authentication, uploads, jobs, persistence, documents,
  collections and isolation, 252 passed and one SQLite-file-location test skipped, in 107 seconds,
  in a throwaway `postgres:16` container published only on `127.0.0.1:55447`. Every test used a
  fresh `pp_test_<uuid>` schema; final SQL checks found zero test schemas and zero public tables,
  and the container was removed.
- `ruff check`, `ruff format --check` and `mypy passageport` (71 source files) passed.

## Reporting

Open a GitHub issue without sensitive details, or contact the maintainer privately for anything
exploitable.
