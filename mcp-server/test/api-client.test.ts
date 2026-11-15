import assert from "node:assert/strict";
import { test } from "node:test";

import { PassagePortClient, PassagePortError } from "../src/api-client.js";
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

const BASE = "http://127.0.0.1:8000";

function clientWith(responder: Responder, options: { token?: string; timeoutMs?: number } = {}) {
  const { fetch, requests } = fakeFetch(responder);
  const client = new PassagePortClient({
    baseUrl: `${BASE}/`,
    token: options.token,
    timeoutMs: options.timeoutMs ?? 1000,
    fetch,
  });
  return { client, requests };
}

async function rejection(promise: Promise<unknown>): Promise<PassagePortError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PassagePortError, `expected PassagePortError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the request to fail");
}

test("GET requests hit the documented paths and send no credentials by default", async () => {
  const { client, requests } = clientWith(() => json([collection]));
  const collections = await client.listCollections();

  assert.equal(collections[0]?.id, "col_1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.url, `${BASE}/api/collections`);
  assert.equal(requests[0]?.headers.Authorization, undefined);
  assert.equal(requests[0]?.headers["X-PassagePort-CSRF"], undefined);
  assert.equal(requests[0]?.body, undefined);
});

test("the API token is sent as a bearer token on every request", async () => {
  const { client, requests } = clientWith(() => json([document]), { token: "pp_secret" });
  await client.listDocuments("col_1");
  assert.equal(requests[0]?.headers.Authorization, "Bearer pp_secret");
});

test("identifiers are URL-encoded into the path", async () => {
  const { client, requests } = clientWith((request) =>
    request.url.includes("/pages/") ? json(page) : json(request.url.includes("/chunks/") ? passage : [document]),
  );
  await client.listDocuments("a/b?c");
  await client.getChunk("../secret");
  await client.getPage("doc 1", 12);

  assert.deepEqual(
    requests.map((r) => r.url),
    [
      `${BASE}/api/collections/a%2Fb%3Fc/documents`,
      `${BASE}/api/chunks/..%2Fsecret`,
      `${BASE}/api/documents/doc%201/pages/12`,
    ],
  );
});

test("search and ask POST the request as JSON with the CSRF header", async () => {
  const { client, requests } = clientWith((request) =>
    json(request.url.endsWith("/api/ask") ? askResponse : searchResponse),
  );
  const found = await client.search({ collection_id: "col_1", query: "vacation days", top_k: 3 });
  const answered = await client.ask({ collection_id: "col_1", question: "How many?" });

  assert.equal(found.results[0]?.chunk_id, "chk_abc");
  assert.equal(answered.evidence[0]?.ref, 1);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.url, `${BASE}/api/search`);
  assert.equal(requests[0]?.headers["Content-Type"], "application/json");
  assert.equal(requests[0]?.headers["X-PassagePort-CSRF"], "1");
  assert.deepEqual(requests[0]?.body, { collection_id: "col_1", query: "vacation days", top_k: 3 });
  assert.deepEqual(requests[1]?.body, { collection_id: "col_1", question: "How many?" });
});

test("API errors surface the server's code, message and status", async () => {
  const { client } = clientWith(() => apiError(404, "not_found", "Collection not found."));
  const error = await rejection(client.listDocuments("missing"));
  assert.equal(error.code, "not_found");
  assert.equal(error.status, 404);
  assert.equal(error.message, "Collection not found.");
});

test("an unauthenticated response explains how to configure the token", async () => {
  const { client } = clientWith(() => apiError(401, "unauthenticated", "Sign in to continue."));
  const error = await rejection(client.listCollections());
  assert.equal(error.code, "unauthenticated");
  assert.match(error.message, /^Sign in to continue\. .*PASSAGEPORT_API_TOKEN/);
});

test("an error code that collides with Object.prototype gets no hint", async () => {
  const { client } = clientWith(() => apiError(400, "constructor", "Odd."));
  const error = await rejection(client.listCollections());
  assert.equal(error.message, "Odd.");
});

test("non-API error bodies are not echoed", async () => {
  const { client } = clientWith(
    () => new Response("<html>Traceback: /srv/app/secret.py</html>", { status: 502 }),
  );
  const error = await rejection(client.listCollections());
  assert.equal(error.code, "http_error");
  assert.equal(error.status, 502);
  assert.ok(!error.message.includes("secret.py"));
});

test("a successful response with the wrong shape is rejected", async () => {
  const html = clientWith(() => new Response("<!doctype html><title>App</title>", { status: 200 }));
  assert.equal((await rejection(html.client.listCollections())).code, "bad_response");

  const wrong = clientWith(() => json({ results: "nope" }));
  assert.equal(
    (await rejection(wrong.client.search({ collection_id: "c", query: "q" }))).code,
    "bad_response",
  );
});

test("requests are aborted after the configured timeout", async () => {
  const { client, requests } = clientWith(
    (request) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
      return promise;
    },
    { timeoutMs: 100 },
  );
  const error = await rejection(client.health());
  assert.equal(error.code, "timeout");
  assert.match(error.message, /100 ms/);
  assert.equal(requests.length, 1);
});

test("network failures become an 'unreachable' error without leaking the token", async () => {
  const { client } = clientWith(
    () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED Bearer pp_secret");
    },
    { token: "pp_secret" },
  );
  const error = await rejection(client.health());
  assert.equal(error.code, "unreachable");
  assert.match(error.message, /Cannot reach PassagePort at http:\/\/127\.0\.0\.1:8000/);
  assert.ok(!error.message.includes("pp_secret"));
});

test("redirects are refused so the token cannot be forwarded to another origin", async () => {
  let redirect: RequestInit["redirect"];
  const client = new PassagePortClient({
    baseUrl: BASE,
    token: "pp_secret",
    timeoutMs: 1000,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return json({ status: "ok" });
    }) as typeof fetch,
  });
  await client.health();
  assert.equal(redirect, "error");
});
