/**
 * A scripted `fetch` that records every request, plus API fixtures shaped like
 * `backend/passageport/api/schemas.py`.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function fakeFetch(responder: Responder): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    requests.push(request);
    return responder(request);
  };
  return { fetch: fetchImpl as typeof fetch, requests };
}

export const collection = {
  id: "col_1",
  name: "Handbook",
  description: "HR documents",
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-02T03:04:05Z",
  document_count: 2,
  indexed_count: 1,
  processing_count: 1,
  failed_count: 0,
  chunk_count: 42,
  size_bytes: 123456,
};

export const document = {
  id: "doc_1",
  collection_id: "col_1",
  title: "Employee Handbook",
  filename: "handbook.pdf",
  kind: "pdf",
  locator_kind: "page",
  size_bytes: 1000,
  sha256: "ab".repeat(32),
  status: "indexed",
  error: null,
  page_count: 30,
  chunk_count: 42,
  stale: false,
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-02T03:04:05Z",
  indexed_at: "2026-01-02T03:05:00Z",
};

export const passage = {
  chunk_id: "chk_abc",
  document_id: "doc_1",
  document_title: "Employee Handbook",
  document_kind: "pdf",
  locator_kind: "page",
  page_number: 12,
  page_label: "Page 12",
  char_start: 100,
  char_end: 160,
  text: "Employees accrue 1.5 vacation days per month of service.",
};

export const hit = {
  ...passage,
  rank: 1,
  scores: {
    keyword: { rank: 1, score: 7.25 },
    semantic: { rank: 2, score: 0.81 },
    fused: 0.032,
    rerank: 4.5,
  },
  matched_terms: ["vacation", "days"],
};

export const searchResponse = {
  query: "vacation days",
  results: [hit],
  low_confidence: false,
  notice: null,
  settings: {
    mode: "hybrid",
    top_k: 8,
    candidates: 30,
    rrf_k: 60,
    lexical_weight: 1,
    vector_weight: 1,
    reranked: true,
    rerank_candidates: 20,
    bm25_k1: 1.2,
    bm25_b: 0.75,
    embedding_version: "hashing:feature-hashing:256",
    reranker: null,
    index_version: 3,
  },
  timings_ms: { total: 12.5 },
};

export const askResponse = {
  question: "How many vacation days do employees accrue?",
  mode: "extractive",
  segments: [
    {
      text: "Employees accrue 1.5 vacation days per month of service.",
      citations: [1],
      supported: true,
    },
  ],
  evidence: [{ ...hit, ref: 1 }],
  notice: null,
  llm_model: null,
  checks: ["Every sentence is quoted verbatim from the cited passage."],
  timings_ms: { total: 20 },
};

export const page = {
  document_id: "doc_1",
  page_number: 12,
  page_label: "Page 12",
  page_count: 30,
  text: "Leave policy. Employees accrue 1.5 vacation days per month of service. Unused days carry over.",
};
