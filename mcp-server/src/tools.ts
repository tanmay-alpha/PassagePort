/**
 * Tool inputs (Zod) and handlers.
 *
 * Handlers return plain objects shaped for a language model: every passage carries what is needed
 * to cite it (document title, page label, chunk id) and to follow it up with `get_passage` or
 * `get_page`. Fields that only matter to the web UI (timings, per-stage ranks) are left out.
 */

import { z } from "zod";

import type { PassagePortClient } from "./api-client.js";
import { SEARCH_MODES, type Passage } from "./types.js";

const id = (what: string) => z.string().trim().min(1).max(200).describe(what);

const documentIds = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(100)
  .optional()
  .describe("Restrict to these document ids (from list_documents). Omit to use the whole collection.");

export const listCollectionsInput = {};

export const listDocumentsInput = {
  collection_id: id("Collection id (from list_collections)."),
};

export const searchInput = {
  collection_id: id("Collection id (from list_collections)."),
  query: z.string().trim().min(1).max(4000).describe("What to look for, in natural language or keywords."),
  mode: z
    .enum(SEARCH_MODES)
    .optional()
    .describe("hybrid (default): BM25 + embeddings fused; keyword: exact terms only; semantic: embeddings only."),
  top_k: z.number().int().min(1).max(50).optional().describe("Number of passages to return (default 8)."),
  document_ids: documentIds,
};

export const getPassageInput = {
  chunk_id: id("Passage id (`chunk_id` from search or ask results)."),
};

export const getPageInput = {
  document_id: id("Document id (from list_documents or a search result)."),
  page_number: z
    .number()
    .int()
    .min(1)
    .describe("1-based page number (PDF) or section number (TXT/MD/DOCX), as given in `page_number`."),
};

export const askInput = {
  collection_id: id("Collection id (from list_collections)."),
  question: z.string().trim().min(1).max(4000).describe("The question to answer from the documents."),
  top_k: z.number().int().min(1).max(12).optional().describe("Number of evidence passages (default 6)."),
  document_ids: documentIds,
};

type Args<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

/** Human-readable citation, e.g. `Employee Handbook — Page 12`. */
export function formatCitation(passage: Pick<Passage, "document_title" | "page_label">): string {
  return `${passage.document_title} — ${passage.page_label}`;
}

function citedPassage(passage: Passage) {
  return {
    citation: formatCitation(passage),
    chunk_id: passage.chunk_id,
    document_id: passage.document_id,
    document_title: passage.document_title,
    locator_kind: passage.locator_kind,
    page_number: passage.page_number,
    page_label: passage.page_label,
    char_start: passage.char_start,
    char_end: passage.char_end,
    text: passage.text,
  };
}

export async function listCollections(client: PassagePortClient) {
  const collections = await client.listCollections();
  return {
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      document_count: c.document_count,
      indexed_count: c.indexed_count,
      processing_count: c.processing_count,
      failed_count: c.failed_count,
      chunk_count: c.chunk_count,
    })),
  };
}

export async function listDocuments(client: PassagePortClient, args: Args<typeof listDocumentsInput>) {
  const documents = await client.listDocuments(args.collection_id);
  return {
    collection_id: args.collection_id,
    documents: documents.map((d) => ({
      id: d.id,
      title: d.title,
      filename: d.filename,
      kind: d.kind,
      locator_kind: d.locator_kind,
      status: d.status,
      error: d.error,
      page_count: d.page_count,
      chunk_count: d.chunk_count,
      stale: d.stale,
    })),
  };
}

export async function search(client: PassagePortClient, args: Args<typeof searchInput>) {
  const response = await client.search({
    collection_id: args.collection_id,
    query: args.query,
    ...(args.mode !== undefined && { mode: args.mode }),
    ...(args.top_k !== undefined && { top_k: args.top_k }),
    ...(args.document_ids !== undefined && { document_ids: args.document_ids }),
  });
  return {
    query: response.query,
    mode: response.settings.mode,
    reranked: response.settings.reranked,
    low_confidence: response.low_confidence,
    notice: response.notice,
    passages: response.results.map((hit) => ({
      rank: hit.rank,
      ...citedPassage(hit),
      matched_terms: hit.matched_terms,
      scores: {
        keyword: hit.scores.keyword?.score ?? null,
        semantic: hit.scores.semantic?.score ?? null,
        fused: hit.scores.fused ?? null,
        rerank: hit.scores.rerank ?? null,
      },
    })),
  };
}

export async function getPassage(client: PassagePortClient, args: Args<typeof getPassageInput>) {
  return citedPassage(await client.getChunk(args.chunk_id));
}

export async function getPage(client: PassagePortClient, args: Args<typeof getPageInput>) {
  const page = await client.getPage(args.document_id, args.page_number);
  return {
    document_id: page.document_id,
    page_number: page.page_number,
    page_label: page.page_label,
    page_count: page.page_count,
    text: page.text,
  };
}

export async function ask(client: PassagePortClient, args: Args<typeof askInput>) {
  const response = await client.ask({
    collection_id: args.collection_id,
    question: args.question,
    ...(args.top_k !== undefined && { top_k: args.top_k }),
    ...(args.document_ids !== undefined && { document_ids: args.document_ids }),
  });
  const answer = response.segments
    .map((segment) => `${segment.text}${segment.citations.map((ref) => ` [${ref}]`).join("")}`)
    .join(" ");
  return {
    question: response.question,
    // generated: written by the server's LLM from the evidence; extractive: verbatim sentences
    // from the evidence; insufficient: the evidence was too weak to answer.
    mode: response.mode,
    answer: answer || null,
    segments: response.segments,
    evidence: response.evidence.map((evidence) => ({ ref: evidence.ref, ...citedPassage(evidence) })),
    notice: response.notice,
    llm_model: response.llm_model,
    checks: response.checks,
  };
}
