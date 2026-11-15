# PassagePort MCP server

A [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an AI assistant
search your PassagePort collections and quote what it finds with page-accurate citations.

It is a thin, read-only client of the PassagePort HTTP API: it never uploads, modifies or
deletes anything, and it talks only to the PassagePort server you configure.

## Tools

| Tool | Input | Returns |
|------|-------|---------|
| `list_collections` | — | Collections with ids and document / passage counts. |
| `list_documents` | `collection_id` | Documents of a collection with indexing status. |
| `search` | `collection_id`, `query`, `mode?` (`hybrid` \| `keyword` \| `semantic`), `top_k?` (1–50), `document_ids?` | Ranked passages. Each has `citation`, `document_title`, `page_label`, `page_number`, `chunk_id`, `document_id`, character offsets, text and scores. |
| `get_passage` | `chunk_id` | The exact text and location of one passage. |
| `get_page` | `document_id`, `page_number` | Full extracted text of one page (PDF) or section (TXT/MD/DOCX). |
| `ask` | `collection_id`, `question`, `top_k?` (1–12), `document_ids?` | An answer with numbered evidence passages. `mode` says how it was produced: `generated` (the server's LLM), `extractive` (verbatim sentences, no LLM) or `insufficient` (no answer). |

Example `search` result (shortened):

```json
{
  "query": "vacation days",
  "mode": "hybrid",
  "reranked": true,
  "low_confidence": false,
  "notice": null,
  "passages": [
    {
      "rank": 1,
      "citation": "Employee Handbook — Page 12",
      "chunk_id": "…",
      "document_id": "…",
      "document_title": "Employee Handbook",
      "locator_kind": "page",
      "page_number": 12,
      "page_label": "Page 12",
      "char_start": 100,
      "char_end": 160,
      "text": "Employees accrue 1.5 vacation days per month of service.",
      "matched_terms": ["vacation", "days"],
      "scores": { "keyword": 7.25, "semantic": 0.81, "fused": 0.032, "rerank": 4.5 }
    }
  ]
}
```

`char_start` / `char_end` index into the text returned by `get_page` for that `page_number`.

## Setup

Requires Node.js 22 or newer and a running PassagePort server.

```bash
cd mcp-server
npm ci
npm run build
```

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PASSAGEPORT_API_URL` | `http://127.0.0.1:8000` | Origin of the PassagePort server. |
| `PASSAGEPORT_API_TOKEN` | _(unset)_ | API token, sent as `Authorization: Bearer …`. Required when the server runs with `PP_AUTH_MODE=accounts`; not needed in the default local mode. |
| `PASSAGEPORT_TIMEOUT_MS` | `90000` | Per-request timeout. |

In accounts mode, sign in to PassagePort and create an API token (`POST /api/auth/tokens`).
The token is shown once. It gives access to that account's
collections only. Use an `https://` URL whenever the server is not on your own machine; the MCP
server warns at startup if a token would be sent over plain HTTP to a remote host.

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "passageport": {
      "command": "node",
      "args": ["/absolute/path/to/PassagePort/mcp-server/dist/index.js"],
      "env": {
        "PASSAGEPORT_API_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

On Windows, write the path with forward slashes or escaped backslashes, for example
`"C:/Users/you/PassagePort/mcp-server/dist/index.js"`.

Against a server in accounts mode:

```json
{
  "mcpServers": {
    "passageport": {
      "command": "node",
      "args": ["/absolute/path/to/PassagePort/mcp-server/dist/index.js"],
      "env": {
        "PASSAGEPORT_API_URL": "https://passageport.example.com",
        "PASSAGEPORT_API_TOKEN": "<your API token>"
      }
    }
  }
}
```

### Other MCP clients

Any client that launches stdio servers works with the same three pieces: the command `node`,
the argument `<path>/mcp-server/dist/index.js`, and the environment variables above. For
example, with Claude Code:

```bash
claude mcp add --transport stdio \
  --env PASSAGEPORT_API_URL=http://127.0.0.1:8000 \
  passageport -- node /absolute/path/to/PassagePort/mcp-server/dist/index.js
```

To try the tools interactively, use the MCP Inspector:

```bash
npm run inspect
```

## Behaviour worth knowing

- **Errors** from the API (`{"error": {"code", "message"}}`) are returned as tool errors with the
  server's message and code, for example `Collection not found. (not_found)`. Network problems
  are reported as `unreachable`, slow responses as `timeout`. Nothing is retried automatically.
- **Input validation** happens before any request is sent (Zod schemas); invalid arguments
  never reach the API.
- **Privacy**: the server logs its version, the API URL and whether a token is set to stderr.
  It never logs queries, document text or the token.
- **`ask` without an LLM**: when the PassagePort server has no LLM configured, answers are
  extractive (sentences quoted from the evidence). The MCP server itself never calls an LLM.

## Development

```bash
npm run dev         # run from source (tsx)
npm run typecheck   # tsc --noEmit, including tests
npm test            # node:test, with a mocked fetch and an in-memory MCP transport
npm run build       # emit dist/
```

Source layout:

| File | Responsibility |
|------|----------------|
| `src/config.ts` | Environment variables → validated configuration. |
| `src/api-client.ts` | HTTP client: auth header, timeout, error mapping, response parsing. |
| `src/types.ts` | Zod parsers for the API responses this server reads. |
| `src/tools.ts` | Tool input schemas and handlers (API response → citation-ready result). |
| `src/server.ts` | Registers the tools on an `McpServer`. |
| `src/index.ts` | stdio entrypoint (`passageport-mcp`). |

## License

MIT — see [`../LICENSE`](../LICENSE) and [`../NOTICE.md`](../NOTICE.md).
