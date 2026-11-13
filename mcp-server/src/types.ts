/**
 * The subset of the PassagePort HTTP API this server reads (contract:
 * `backend/passageport/api/schemas.py`).
 *
 * Responses are parsed, not just typed, so a wrong URL or an incompatible server version fails
 * with a clear message instead of producing citations with missing fields. The parsers are
 * tolerant readers: unknown fields are dropped and enum-like fields are plain strings, so the
 * API can grow without breaking this client.
 */

import { z } from "zod";

export const SEARCH_MODES = ["hybrid", "keyword", "semantic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const healthSchema = z.object({ status: z.string() });

export const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  document_count: z.number(),
  indexed_count: z.number(),
  processing_count: z.number(),
  failed_count: z.number(),
  chunk_count: z.number(),
});
export type Collection = z.infer<typeof collectionSchema>;

export const documentSchema = z.object({
  id: z.string(),
  collection_id: z.string(),
  title: z.string(),
  filename: z.string(),
  kind: z.string(),
  locator_kind: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  page_count: z.number(),
  chunk_count: z.number(),
  stale: z.boolean(),
});
export type Document = z.infer<typeof documentSchema>;

/** A citation target: `char_start`/`char_end` index into the text of page `page_number`. */
export const passageSchema = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  document_title: z.string(),
  document_kind: z.string(),
  locator_kind: z.string(),
  page_number: z.number(),
  page_label: z.string(),
  char_start: z.number(),
  char_end: z.number(),
  text: z.string(),
});
export type Passage = z.infer<typeof passageSchema>;

const stageScoreSchema = z.object({ rank: z.number(), score: z.number() });

export const hitSchema = passageSchema.extend({
  rank: z.number(),
  scores: z.object({
    keyword: stageScoreSchema.nullish(),
    semantic: stageScoreSchema.nullish(),
    fused: z.number().nullish(),
    rerank: z.number().nullish(),
  }),
  matched_terms: z.array(z.string()).default([]),
});
export type Hit = z.infer<typeof hitSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(hitSchema),
  low_confidence: z.boolean(),
  notice: z.string().nullable(),
  settings: z.object({ mode: z.string(), reranked: z.boolean() }),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const evidenceSchema = hitSchema.extend({ ref: z.number() });
export type Evidence = z.infer<typeof evidenceSchema>;

export const askResponseSchema = z.object({
  question: z.string(),
  mode: z.string(),
  segments: z.array(
    z.object({ text: z.string(), citations: z.array(z.number()), supported: z.boolean() }),
  ),
  evidence: z.array(evidenceSchema),
  notice: z.string().nullable(),
  llm_model: z.string().nullable(),
  checks: z.array(z.string()),
});
export type AskResponse = z.infer<typeof askResponseSchema>;

export const pageSchema = z.object({
  document_id: z.string(),
  page_number: z.number(),
  page_label: z.string(),
  page_count: z.number(),
  text: z.string(),
});
export type Page = z.infer<typeof pageSchema>;

export interface SearchRequest {
  collection_id: string;
  query: string;
  mode?: SearchMode;
  top_k?: number;
  document_ids?: string[];
}

export interface AskRequest {
  collection_id: string;
  question: string;
  top_k?: number;
  document_ids?: string[];
}
