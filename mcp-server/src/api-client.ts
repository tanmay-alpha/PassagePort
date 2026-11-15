/**
 * HTTP client for the PassagePort API.
 *
 * Every failure is turned into a `PassagePortError` whose message is safe to show to the model:
 * it never contains the API token, response bodies other than the API's own error message, or
 * stack traces.
 */

import { z } from "zod";

import {
  askResponseSchema,
  collectionSchema,
  documentSchema,
  healthSchema,
  pageSchema,
  passageSchema,
  searchResponseSchema,
  type AskRequest,
  type AskResponse,
  type Collection,
  type Document,
  type Page,
  type Passage,
  type SearchRequest,
  type SearchResponse,
} from "./types.js";

export interface ClientOptions {
  /** Server origin without trailing slash, e.g. `http://127.0.0.1:8000`. */
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export class PassagePortError extends Error {
  override name = "PassagePortError";

  constructor(
    /** API error code (`not_found`, `rate_limited`, ...) or a client-side one (`timeout`, `unreachable`, `bad_response`). */
    readonly code: string,
    message: string,
    /** HTTP status, when the server answered. */
    readonly status?: number,
  ) {
    super(message);
  }
}

const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const HINTS: Record<string, string> = {
  unauthenticated:
    "Set PASSAGEPORT_API_TOKEN to an API token created in PassagePort (accounts mode requires one).",
  forbidden:
    "In local mode PassagePort only answers loopback Host headers; check PASSAGEPORT_API_URL and the token's permissions.",
};

export class PassagePortClient {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  health(): Promise<{ status: string }> {
    return this.#request(healthSchema, "GET", "/api/health");
  }

  listCollections(): Promise<Collection[]> {
    return this.#request(z.array(collectionSchema), "GET", "/api/collections");
  }

  listDocuments(collectionId: string): Promise<Document[]> {
    return this.#request(
      z.array(documentSchema),
      "GET",
      `/api/collections/${encodeURIComponent(collectionId)}/documents`,
    );
  }

  search(request: SearchRequest): Promise<SearchResponse> {
    return this.#request(searchResponseSchema, "POST", "/api/search", request);
  }

  ask(request: AskRequest): Promise<AskResponse> {
    return this.#request(askResponseSchema, "POST", "/api/ask", request);
  }

  getChunk(chunkId: string): Promise<Passage> {
    return this.#request(passageSchema, "GET", `/api/chunks/${encodeURIComponent(chunkId)}`);
  }

  getPage(documentId: string, pageNumber: number): Promise<Page> {
    return this.#request(
      pageSchema,
      "GET",
      `/api/documents/${encodeURIComponent(documentId)}/pages/${pageNumber}`,
    );
  }

  async #request<T>(
    schema: z.ZodType<T>,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      // The API requires this header on state-changing methods from cookie sessions; sending it
      // always keeps POSTs working in local mode too.
      headers["X-PassagePort-CSRF"] = "1";
    }

    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error", // never forward the bearer token to another origin
      });
      status = response.status;
      ok = response.ok;
      text = await response.text();
    } catch (error) {
      throw this.#transportError(error);
    }

    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }

    if (!ok) {
      const parsed = apiErrorSchema.safeParse(payload);
      if (parsed.success) {
        const { code, message } = parsed.data.error;
        const hint = Object.hasOwn(HINTS, code) ? HINTS[code] : undefined;
        throw new PassagePortError(code, hint ? `${message} ${hint}` : message, status);
      }
      throw new PassagePortError(
        "http_error",
        `PassagePort answered HTTP ${status} without an API error body. Is PASSAGEPORT_API_URL pointing at a PassagePort server?`,
        status,
      );
    }

    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new PassagePortError(
        "bad_response",
        "PassagePort returned a response this MCP server does not understand. " +
          "Check that PASSAGEPORT_API_URL points at a PassagePort server of a compatible version.",
        status,
      );
    }
    return result.data;
  }

  #transportError(error: unknown): PassagePortError {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return new PassagePortError(
        "timeout",
        `PassagePort did not answer within ${this.#timeoutMs} ms.`,
      );
    }
    return new PassagePortError(
      "unreachable",
      `Cannot reach PassagePort at ${this.#baseUrl}. Is the server running?`,
    );
  }
}
