/**
 * MCP server wiring: registers the PassagePort tools on an `McpServer`.
 *
 * Kept separate from the stdio entrypoint so tests can drive the same server over an in-memory
 * transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { PassagePortError, type PassagePortClient } from "./api-client.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import * as tools from "./tools.js";

/** All tools only read from PassagePort and talk to one known server. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

function describeError(error: unknown): string {
  if (error instanceof PassagePortError) return `${error.message} (${error.code})`;
  // Unknown failures are reported by type only; their messages may contain document text.
  return `Unexpected error in the PassagePort MCP server (${error instanceof Error ? error.name : "unknown"}).`;
}

async function respond(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run(), null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: describeError(error) }] };
  }
}

export function createServer(client: PassagePortClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "PassagePort searches the user's own document collections. Start with list_collections, " +
        "then search or ask within one collection. Quote passages verbatim and cite them with " +
        "their `citation` (document title and page label). Use get_page to read around a passage.",
    },
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description:
        "List the document collections in PassagePort with their document and passage counts. " +
        "Call this first to get a collection_id.",
      inputSchema: tools.listCollectionsInput,
      annotations: READ_ONLY,
    },
    () => respond(() => tools.listCollections(client)),
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description:
        "List the documents of one collection with their indexing status. Only documents with " +
        "status `indexed` are searchable; `stale` documents are excluded from semantic search " +
        "until they are re-indexed in PassagePort.",
      inputSchema: tools.listDocumentsInput,
      annotations: READ_ONLY,
    },
    (args) => respond(() => tools.listDocuments(client, args)),
  );

  server.registerTool(
    "search",
    {
      title: "Search passages",
      description:
        "Search one collection and return ranked passages. Each passage includes its citation " +
        "(document title, page label), `chunk_id`, `document_id` and `page_number`. " +
        "`low_confidence: true` means nothing cleared the relevance thresholds; treat such " +
        "results as weak evidence.",
      inputSchema: tools.searchInput,
      annotations: READ_ONLY,
    },
    (args) => respond(() => tools.search(client, args)),
  );

  server.registerTool(
    "get_passage",
    {
      title: "Get passage",
      description:
        "Resolve a `chunk_id` to its exact text and location (document, page, character range).",
      inputSchema: tools.getPassageInput,
      annotations: READ_ONLY,
    },
    (args) => respond(() => tools.getPassage(client, args)),
  );

  server.registerTool(
    "get_page",
    {
      title: "Get page",
      description:
        "Return the full extracted text of one page (PDF) or section (TXT/MD/DOCX) of a document, " +
        "to read the context around a passage.",
      inputSchema: tools.getPageInput,
      annotations: READ_ONLY,
    },
    (args) => respond(() => tools.getPage(client, args)),
  );

  server.registerTool(
    "ask",
    {
      title: "Ask the documents",
      description:
        "Answer a question from one collection with numbered evidence passages. `mode` tells how " +
        "the answer was produced: `generated` (the server's LLM wrote it from the evidence), " +
        "`extractive` (verbatim sentences, no LLM) or `insufficient` (evidence too weak; no answer). " +
        "Citations like [1] refer to `evidence[].ref`.",
      inputSchema: tools.askInput,
      annotations: READ_ONLY,
    },
    (args) => respond(() => tools.ask(client, args)),
  );

  return server;
}
