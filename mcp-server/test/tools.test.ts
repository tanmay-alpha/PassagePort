/**
 * Drives the real MCP server over an in-memory transport, so input validation, tool
 * registration and result encoding are exercised exactly as an MCP client sees them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PassagePortClient } from "../src/api-client.js";
import { SERVER_NAME } from "../src/config.js";
import { createServer } from "../src/server.js";
import {
  apiError,
  askResponse,
  collection,
  document,
  fakeFetch,
  json,
  page,
  passage,
  searchResponse,
  type Responder,
} from "./helpers.js";

interface ToolOutcome {
  isError: boolean;
  text: string;
}

async function connect(responder: Responder) {
  const { fetch, requests } = fakeFetch(responder);
  const api = new PassagePortClient({ baseUrl: "http://127.0.0.1:8000", timeoutMs: 1000, fetch });
  const server = createServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    assert.equal(content.length, 1);
    assert.equal(content[0]?.type, "text");
    return { isError: result.isError === true, text: content[0]?.text ?? "" };
  }

  async function callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const outcome = await call(name, args);
    assert.equal(outcome.isError, false, outcome.text);
    return JSON.parse(outcome.text);
  }

  return { client, requests, call, callJson };
}

test("the server identifies as PassagePort and exposes exactly the documented tools", async () => {
  const { client } = await connect(() => json([]));
  assert.equal(client.getServerVersion()?.name, SERVER_NAME);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["ask", "get_page", "get_passage", "list_collections", "list_documents", "search"],
  );
  for (const tool of tools) {
    assert.ok(tool.description, tool.name);
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
  }
  const search = tools.find((tool) => tool.name === "search");
  assert.deepEqual(search?.inputSchema.required?.toSorted(), ["collection_id", "query"]);
});

test("list_collections returns ids and counts", async () => {
  const { callJson, requests } = await connect(() => json([collection]));
  const result = await callJson("list_collections");

  assert.equal(requests[0]?.url, "http://127.0.0.1:8000/api/collections");
  assert.deepEqual(result, {
    collections: [
      {
        id: "col_1",
        name: "Handbook",
        description: "HR documents",
        document_count: 2,
        indexed_count: 1,
        processing_count: 1,
        failed_count: 0,
        chunk_count: 42,
      },
    ],
  });
});

test("list_documents returns status information for one collection", async () => {
  const failed = { ...document, id: "doc_2", status: "failed", error: "The PDF has no extractable text." };
  const { callJson, requests } = await connect(() => json([document, failed]));
  const result = await callJson("list_documents", { collection_id: "col_1" });

  assert.equal(requests[0]?.url, "http://127.0.0.1:8000/api/collections/col_1/documents");
  assert.equal(result.collection_id, "col_1");
  assert.deepEqual(
    result.documents.map((d: { id: string; status: string }) => [d.id, d.status]),
    [
      ["doc_1", "indexed"],
      ["doc_2", "failed"],
    ],
  );
  assert.equal(result.documents[1].error, "The PDF has no extractable text.");
  assert.equal(result.documents[0].sha256, undefined);
});

test("search returns passages with citation metadata", async () => {
  const { callJson, requests } = await connect(() => json(searchResponse));
  const result = await callJson("search", {
    collection_id: "col_1",
    query: "  vacation days ",
    mode: "keyword",
    top_k: 5,
    document_ids: ["doc_1"],
  });

  assert.deepEqual(requests[0]?.body, {
    collection_id: "col_1",
    query: "vacation days",
    mode: "keyword",
    top_k: 5,
    document_ids: ["doc_1"],
  });
  assert.equal(result.low_confidence, false);
  assert.equal(result.passages.length, 1);
  assert.deepEqual(result.passages[0], {
    rank: 1,
    citation: "Employee Handbook — Page 12",
    chunk_id: "chk_abc",
    document_id: "doc_1",
    document_title: "Employee Handbook",
    locator_kind: "page",
    page_number: 12,
    page_label: "Page 12",
    char_start: 100,
    char_end: 160,
    text: passage.text,
    matched_terms: ["vacation", "days"],
    scores: { keyword: 7.25, semantic: 0.81, fused: 0.032, rerank: 4.5 },
  });
});

test("search leaves optional settings to the server when they are omitted", async () => {
  const { callJson, requests } = await connect(() => json(searchResponse));
  await callJson("search", { collection_id: "col_1", query: "vacation" });
  assert.deepEqual(requests[0]?.body, { collection_id: "col_1", query: "vacation" });
});

test("search passes a low-confidence notice through", async () => {
  const { callJson } = await connect(() =>
    json({ ...searchResponse, results: [], low_confidence: true, notice: "No passage matched." }),
  );
  const result = await callJson("search", { collection_id: "col_1", query: "zebra" });
  assert.deepEqual(result.passages, []);
  assert.equal(result.low_confidence, true);
  assert.equal(result.notice, "No passage matched.");
});

test("invalid arguments are rejected before any request is made", async () => {
  const { call, requests } = await connect(() => json(searchResponse));
  const invalid: [string, Record<string, unknown>][] = [
    ["search", { collection_id: "col_1" }],
    ["search", { collection_id: "col_1", query: "   " }],
    ["search", { collection_id: "col_1", query: "q", top_k: 0 }],
    ["search", { collection_id: "col_1", query: "q", top_k: 51 }],
    ["search", { collection_id: "col_1", query: "q", mode: "fuzzy" }],
    ["search", { collection_id: "col_1", query: "q", document_ids: [] }],
    ["list_documents", {}],
    ["get_page", { document_id: "doc_1", page_number: 0 }],
    ["get_page", { document_id: "doc_1", page_number: 1.5 }],
    ["get_passage", { chunk_id: "" }],
    ["ask", { collection_id: "col_1", question: "q", top_k: 13 }],
  ];
  for (const [name, args] of invalid) {
    const outcome = await call(name, args);
    assert.equal(outcome.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, 0);
});

test("get_passage resolves a chunk id to a cited passage", async () => {
  const { callJson, requests } = await connect(() => json(passage));
  const result = await callJson("get_passage", { chunk_id: "chk_abc" });

  assert.equal(requests[0]?.url, "http://127.0.0.1:8000/api/chunks/chk_abc");
  assert.equal(result.citation, "Employee Handbook — Page 12");
  assert.equal(result.chunk_id, "chk_abc");
  assert.equal(result.text, passage.text);
});

test("get_page returns the text of one page", async () => {
  const { callJson, requests } = await connect(() => json(page));
  const result = await callJson("get_page", { document_id: "doc_1", page_number: 12 });

  assert.equal(requests[0]?.url, "http://127.0.0.1:8000/api/documents/doc_1/pages/12");
  assert.deepEqual(result, page);
});

test("ask returns the answer with numbered, cited evidence", async () => {
  const { callJson, requests } = await connect(() => json(askResponse));
  const result = await callJson("ask", { collection_id: "col_1", question: "How many vacation days?" });

  assert.equal(requests[0]?.url, "http://127.0.0.1:8000/api/ask");
  assert.deepEqual(requests[0]?.body, { collection_id: "col_1", question: "How many vacation days?" });
  assert.equal(result.mode, "extractive");
  assert.equal(result.answer, "Employees accrue 1.5 vacation days per month of service. [1]");
  assert.equal(result.llm_model, null);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].ref, 1);
  assert.equal(result.evidence[0].citation, "Employee Handbook — Page 12");
  assert.equal(result.evidence[0].chunk_id, "chk_abc");
  assert.deepEqual(result.checks, askResponse.checks);
});

test("ask reports insufficient evidence without inventing an answer", async () => {
  const { callJson } = await connect(() =>
    json({
      ...askResponse,
      mode: "insufficient",
      segments: [],
      evidence: [],
      notice: "The documents do not contain enough evidence to answer this.",
    }),
  );
  const result = await callJson("ask", { collection_id: "col_1", question: "Who won in 1930?" });
  assert.equal(result.mode, "insufficient");
  assert.equal(result.answer, null);
  assert.match(result.notice, /not contain enough evidence/);
});

test("API errors come back as tool errors with the server's message", async () => {
  const { call } = await connect(() => apiError(404, "not_found", "Collection not found."));
  const outcome = await call("search", { collection_id: "nope", query: "q" });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "Collection not found. (not_found)");
});

test("rate limiting is reported, not retried", async () => {
  const { call, requests } = await connect(() =>
    apiError(429, "rate_limited", "Too many requests. Wait a moment and try again."),
  );
  const outcome = await call("ask", { collection_id: "col_1", question: "q" });
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Too many requests.*\(rate_limited\)/);
  assert.equal(requests.length, 1);
});

test("an unreachable backend is a tool error, not a crash", async () => {
  const { call } = await connect(() => {
    throw new TypeError("fetch failed");
  });
  const outcome = await call("list_collections");
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Cannot reach PassagePort at http:\/\/127\.0\.0\.1:8000.*\(unreachable\)/);
});
