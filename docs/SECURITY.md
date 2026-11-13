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
| Oversized uploads, decompression bombs | Uploads are read in bounded chunks and rejected past `PP_MAX_UPLOAD_MB`; DOCX archives are checked against entry-count and uncompressed-size caps before extraction; page and character caps per document; per-user document and storage quotas. | `test_uploads.py`, `test_parsing.py` |
| Malformed or malicious PDFs | Parsing runs in a separate process that is killed after `PP_PARSE_TIMEOUT_SECONDS` (with an address-space limit on POSIX). A crash or hang fails that one document with a readable message; the server keeps running and the original file is kept. | `test_parsing.py`, `test_jobs.py` |
| XSS / HTML injection from document text or model output | The UI renders passages, answers and filenames as text (React escaping; no `dangerouslySetInnerHTML`, no Markdown-to-HTML). Original files are served with a fixed `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and as attachments unless they are PDFs. The app itself is served with a strict CSP (`script-src 'self'`). | `test_security.py`, frontend tests |
| Unauthorized access, cross-user leakage | Accounts mode: argon2id password hashes; random 256-bit session tokens stored only as SHA-256; `HttpOnly`, `SameSite=Lax`, `Secure` cookies; sessions expire server-side and are rotated on login. Every repository query filters by owner. Search indexes are per collection and a request can only name collections and documents it owns. | `test_auth.py`, `test_isolation.py`, `test_search*.py` |
| CSRF, DNS rebinding | State-changing requests must carry `X-PassagePort-CSRF: 1` and, when an `Origin` header is present, it must match the server's origin. Local mode additionally rejects non-loopback `Host` headers. CORS is off unless origins are listed explicitly. | `test_security.py` |
| Credential stuffing | Login attempts are throttled per username and per client address; failures return one generic message; unknown usernames cost the same hashing time. | `test_auth.py` |
| Resource exhaustion | Compute-heavy endpoints are rate-limited per user; query length, `top_k`, candidates and compared documents are bounded by the request schemas; one indexing job runs at a time per process. | `test_search*.py` |
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
- **Rate limits and login throttling are per process and in memory.** They bound abuse of a single
  instance; they are not a distributed quota.
- **No malware scanning** of uploads. Files are parsed, never executed, and served back with
  sandboxing headers.
- **The parser sandbox is a process boundary, not a container.** It contains hangs and crashes; a
  parser vulnerability that achieves code execution would run with the server's privileges.
- **Generated answers are not fact-checked.** The UI states what was checked (citations resolve to
  retrieved passages) and what was not.
- **Scanned PDFs are rejected** (no OCR), so nothing is silently indexed as empty.
- **Guest accounts** (if enabled) are isolated like normal accounts but are deleted after
  `PP_GUEST_TTL_HOURS`.

## Reporting

Open a GitHub issue without sensitive details, or contact the maintainer privately for anything
exploitable.
