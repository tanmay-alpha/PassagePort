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
| Arbitrary server-side file read (upstream `/encode_doc`, `/encode_batch`) | Endpoints removed. Documents enter only through multipart upload. Stored files are addressed by server-generated IDs; a client-supplied filename is display text only. | `test_security.py` |
| SSRF (upstream `/ingest_llms_txt`) | Endpoint removed. The server makes outbound requests only to the configured LLM endpoint and, on first start, to download models. | — |
| Path traversal, unsafe filenames | Filenames are reduced to a sanitized basename; blob keys never contain user input; the static file handler resolves paths inside the build directory only. | `test_security.py`, `test_uploads.py` |
| Content-type spoofing, unsupported formats | Extension allowlist **and** content sniffing: `%PDF-` header, DOCX must be a ZIP containing `word/document.xml`, text must be valid UTF-8 without NUL bytes. The client's `Content-Type` is ignored. | `test_uploads.py` |
| Oversized uploads, decompression bombs | Uploads are read in bounded chunks and rejected past `PP_MAX_UPLOAD_MB`; DOCX EOCD and central-directory byte/count bounds are checked **before** `ZipFile` can allocate entry objects, then uncompressed-size caps are checked before extraction. ZIP64 and split archives are rejected. Page and character caps also bound parsing. | `test_uploads.py`, `test_parsing.py` |
| Malformed or malicious PDFs | Parsing runs in a separate process that is killed after `PP_PARSE_TIMEOUT_SECONDS` (with an address-space limit on POSIX). A crash or hang fails that one document with a readable message; the server keeps running and the original file is kept. | `test_parsing.py`, `test_jobs.py` |
| XSS / HTML injection from document text or model output | The UI renders passages, answers and filenames as text (React escaping; no `dangerouslySetInnerHTML`, no Markdown-to-HTML). Original files are served with a fixed `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and as attachments unless they are PDFs. The app itself is served with a strict CSP (`script-src 'self'`). | `test_security.py`, frontend tests |
| Unauthorized access, cross-user leakage | Accounts mode: argon2id password hashes; random 256-bit session tokens stored only as SHA-256; `HttpOnly`, `SameSite=Lax`, `Secure` cookies; sessions expire server-side and are rotated on login. Every repository query filters by owner. Search indexes are per collection and a request can only name collections and documents it owns. | `test_auth.py`, `test_isolation.py`, `test_search*.py` |
| CSRF, DNS rebinding | State-changing requests must carry `X-PassagePort-CSRF: 1` and, when an `Origin` header is present, it must match the server's origin. Local mode additionally rejects non-loopback `Host` headers. CORS is off unless origins are listed explicitly. | `test_security.py` |
| Credential stuffing | Login attempts reserve username and client-address throttle slots atomically **before** Argon2 verification, including concurrent requests; failures return one generic message; unknown usernames perform password verification against a dummy hash. | `test_auth.py` |
| Resource exhaustion | Compute-heavy endpoints are rate-limited per user; query length, `top_k`, candidates and compared documents are bounded by the request schemas; one indexing job runs at a time per process. | `test_search*.py` |
| Concurrent quota bypass | Upload document/storage quotas, the collection limit (`PP_MAX_COLLECTIONS_PER_USER`, default 100), and the API-token limit (20) are checked under a per-user database row lock. SQLite uses its write lock instead. Concurrent instances therefore cannot independently spend the same remaining quota. | `test_uploads.py`, `test_collections.py`, `test_auth.py` |
| Stale indexing workers | The claimed attempt fences every worker mutation: the initial `processing` status, retries, failures, and the transaction that replaces the index. A worker resuming after a successor completed cannot change the document or its index. | `test_jobs.py` |
| Blob/document lifecycle races | Database blobs are created and deleted in their document transaction. Collection and guest deletion lock the owner before collecting blob keys, so an in-flight upload cannot leave stored bytes behind. The DB orphan sweep deletes only rows without a document reference in the same SQL statement. | `test_persistence.py` |
| Prompt injection from document content | Passages are sent to the LLM as numbered, delimited quotations with delimiter look-alikes neutralized, under a system instruction that they are data. The model has no tools and cannot trigger requests. Its output is treated as untrusted text: citations that do not match a retrieved passage are dropped, uncited sentences are flagged, and it is rendered as plain text. | `test_ask*.py`, `test_llm*.py` |
| Leaking document text or credentials in logs and errors | Logs contain IDs, counts and exception types, not document text, queries, passwords or keys. API errors use fixed messages; unhandled exceptions return a generic 500. `/api/system` exposes model names and limits, never keys, URLs or paths. | `test_security.py`, `test_llm*.py` |
| Remote code via model repositories | Default models are ONNX files run by ONNX Runtime; no repository code is executed. The optional PyTorch backend enables `trust_remote_code` only for the two upstream `Alibaba-NLP/gte-multilingual-*` models, which require it. | — |

## What an LLM provider sees

Nothing, unless you configure one. With `PP_LLM_BASE_URL` set, the question and the text of the
top retrieved passages (not whole documents) are sent to that endpoint for Ask and for the optional
interpretation in Compare. Point it at a local server (for example Ollama) to keep everything on
your machine.

## Known limitations

- **Not encrypted at rest.** Files and the database are stored as-is; use disk encryption.
- **Compute rate limits and credential throttles are per process and in memory.** Multiple server
  processes do not share these counters. Document, storage, collection and API-token quotas are
  database-serialized and do apply across processes sharing the same database.
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

## Audit verification (2026-11-14)

The backend security/storage regression selection ran with the hashing embedder and no reranker;
it does not measure production model quality or replace a penetration test.

- **SQLite:** 335 passed in 106.27 seconds across authentication, collections, documents, isolation,
  jobs, parsing, persistence, HTTP security and uploads.
- **Real PostgreSQL 17.12:** 228 passed, one SQLite-file-location test skipped, in 154.81 seconds
  across persistence, uploads, collections, authentication, jobs, documents and isolation.
  The throwaway `postgres:17` container published only on `127.0.0.1:55433`; port 55432 was already
  occupied and its existing database was not touched.
- Every PostgreSQL test used a fresh `pp_test_<uuid>` schema, explicitly asserted the PostgreSQL
  dialect and its current schema, and dropped only that schema afterward. Final SQL checks found
  **zero test schemas and zero public tables**. The test container and its anonymous volume were removed.
- Targeted Ruff checks passed; mypy reported no issues in 28 owned source files.
- Regressions exercise a 30,000-entry DOCX rejection before ZIP entry allocation, concurrent
  upload/storage/collection/token quotas, HTTP login bursts before hashing, stale-worker status
  and result fencing, in-flight blob sweeping, transaction rollback, and periodic guest cleanup.
  Invalid zero/negative embedding batch sizes, job leases and attempt counts fail configuration
  validation instead of starting broken workers. Exception logging remains type-only even at DEBUG.

## Reporting

Open a GitHub issue without sensitive details, or contact the maintainer privately for anything
exploitable.
