/**
 * Wire types. These mirror `backend/passageport/api/schemas.py` field for field; that module
 * is the contract. Timestamps are ISO-8601 UTC strings, ids are opaque strings.
 */

export type DocumentStatus = 'uploaded' | 'processing' | 'indexed' | 'failed'
export type DocumentKind = 'pdf' | 'txt' | 'md' | 'docx'
/** pdf -> page; txt/md/docx -> section */
export type LocatorKind = 'page' | 'section'
export type SearchMode = 'hybrid' | 'keyword' | 'semantic'
export type AuthMode = 'local' | 'accounts'

// ----------------------------------------------------------------------------- errors

export interface ErrorBody {
  code: string
  message: string
}

export interface ErrorResponse {
  error: ErrorBody
}

// ----------------------------------------------------------------------------- session / auth

export interface UserOut {
  id: string
  username: string
  is_guest: boolean
}

export interface SessionOut {
  auth_mode: AuthMode
  authenticated: boolean
  user: UserOut | null
  signup_enabled: boolean
  signup_requires_code: boolean
  guests_enabled: boolean
}

export interface CredentialsIn {
  username: string
  password: string
  signup_code?: string | null
}

export interface ApiTokenIn {
  name: string
}

export interface ApiTokenOut {
  id: string
  name: string
  created_at: string
  /** Only present in the creation response. */
  token?: string | null
}

// ----------------------------------------------------------------------------- system

export interface ModelInfo {
  backend: string
  model: string
  dimensions?: number | null
  loaded: boolean
  enabled?: boolean
}

export interface LimitsOut {
  max_upload_bytes: number
  allowed_extensions: string[]
  max_documents: number
  max_storage_bytes: number
  max_query_chars: number
}

export interface SearchDefaults {
  mode: SearchMode
  top_k: number
  candidates: number
  rrf_k: number
  lexical_weight: number
  vector_weight: number
  rerank: boolean
  rerank_candidates: number
  bm25_k1: number
  bm25_b: number
  chunk_max_tokens: number
}

export interface UsageOut {
  collections: number
  documents: number
  chunks: number
  storage_bytes: number
}

export interface SystemOut {
  version: string
  auth_mode: AuthMode
  database: 'sqlite' | 'postgresql'
  blob_backend: 'fs' | 'db'
  embedding: ModelInfo
  reranker: ModelInfo
  llm_configured: boolean
  llm_model: string | null
  limits: LimitsOut
  search_defaults: SearchDefaults
  usage: UsageOut
  pending_jobs: number
}

// ----------------------------------------------------------------------------- collections

export interface CollectionIn {
  name: string
  description?: string
}

export interface CollectionPatch {
  name?: string | null
  description?: string | null
}

export interface CollectionOut {
  id: string
  name: string
  description: string
  created_at: string
  updated_at: string
  document_count: number
  indexed_count: number
  /** uploaded + processing */
  processing_count: number
  failed_count: number
  chunk_count: number
  size_bytes: number
}

// ----------------------------------------------------------------------------- documents

export interface DocumentOut {
  id: string
  collection_id: string
  title: string
  filename: string
  kind: DocumentKind
  locator_kind: LocatorKind
  size_bytes: number
  sha256: string
  status: DocumentStatus
  /**
   * Reason for the last failed indexing attempt. May be set while status is "indexed" when a
   * re-index failed and the previous index was kept.
   */
  error: string | null
  page_count: number
  chunk_count: number
  /** Index built with a different embedding model / chunker than the server uses now. */
  stale: boolean
  created_at: string
  updated_at: string
  indexed_at: string | null
}

export interface DocumentPatch {
  title: string
}

export interface UploadOut {
  document: DocumentOut
  duplicate: boolean
}

export interface PageOut {
  document_id: string
  page_number: number
  page_label: string
  page_count: number
  text: string
}

export interface OutlineItem {
  page_number: number
  page_label: string
}

export interface OutlineOut {
  document_id: string
  locator_kind: LocatorKind
  items: OutlineItem[]
}

// ----------------------------------------------------------------------------- passages / hits

export interface StageScore {
  /** 1-based rank within that retriever */
  rank: number
  score: number
}

export interface HitScores {
  /** BM25 */
  keyword?: StageScore | null
  /** cosine similarity */
  semantic?: StageScore | null
  /** weighted reciprocal-rank fusion score */
  fused?: number | null
  /** cross-encoder logit */
  rerank?: number | null
}

/** A citation target. `char_start`/`char_end` index into the text of the page (code points). */
export interface Passage {
  chunk_id: string
  document_id: string
  document_title: string
  document_kind: DocumentKind
  locator_kind: LocatorKind
  page_number: number
  page_label: string
  char_start: number
  char_end: number
  text: string
}

export interface Hit extends Passage {
  /** 1-based position in this result list */
  rank: number
  scores: HitScores
  matched_terms: string[]
}

export type ChunkOut = Passage

// ----------------------------------------------------------------------------- search

export interface SearchIn {
  query: string
  collection_id: string
  document_ids?: string[] | null
  mode?: SearchMode
  /** null -> server default */
  rerank?: boolean | null
  top_k?: number
}

export interface EffectiveSettings {
  mode: SearchMode
  top_k: number
  candidates: number
  rrf_k: number
  lexical_weight: number
  vector_weight: number
  reranked: boolean
  rerank_candidates: number
  bm25_k1: number
  bm25_b: number
  embedding_version: string
  reranker: string | null
  index_version: number
}

export interface SearchOut {
  query: string
  results: Hit[]
  /** Nothing cleared the relevance thresholds; results (if any) are best-effort. */
  low_confidence: boolean
  notice: string | null
  settings: EffectiveSettings
  timings_ms: Record<string, number>
}

// ----------------------------------------------------------------------------- ask

export interface AskIn {
  question: string
  collection_id: string
  document_ids?: string[] | null
  top_k?: number
}

export interface Evidence extends Hit {
  /** the [n] used in answer citations, 1-based */
  ref: number
}

export interface AnswerSegment {
  text: string
  citations: number[]
  supported: boolean
}

export type AskMode = 'generated' | 'extractive' | 'insufficient'

export interface AskOut {
  question: string
  mode: AskMode
  segments: AnswerSegment[]
  evidence: Evidence[]
  notice: string | null
  llm_model: string | null
  checks: string[]
  timings_ms: Record<string, number>
}

// ----------------------------------------------------------------------------- compare

export interface CompareIn {
  question: string
  document_ids: string[]
  top_k_per_document?: number
  interpret?: boolean
}

export interface CompareDocument {
  document_id: string
  title: string
  has_evidence: boolean
  evidence: Evidence[]
}

export interface AlignedPassage {
  document_id: string
  ref: number
}

export interface NumericDifference {
  context: string
  /** document_id -> value as written */
  values: Record<string, string>
}

export interface Alignment {
  passages: AlignedPassage[]
  similarity: number
  shared_sentences: string[]
  /** document_id -> sentences with no close counterpart */
  unique_sentences: Record<string, string[]>
  numeric_differences: NumericDifference[]
  identical: boolean
}

export interface CompareOut {
  question: string
  documents: CompareDocument[]
  alignments: Alignment[]
  unaligned: AlignedPassage[]
  interpretation: AnswerSegment[] | null
  llm_model: string | null
  notice: string | null
  timings_ms: Record<string, number>
}

// ----------------------------------------------------------------------------- search lab

export interface LabIn {
  query: string
  collection_id: string
  document_ids?: string[] | null
  top_k?: number
  candidates?: number | null
  rrf_k?: number | null
  lexical_weight?: number | null
  vector_weight?: number | null
  rerank?: boolean
}

export interface LabStage {
  results: Hit[]
  ms: number
}

export interface IndexInfo {
  chunks: number
  documents: number
  vocabulary: number
  average_chunk_tokens: number
  index_version: number
  build_ms: number
  cached: boolean
  vector_search: string
  tokenizer: string
}

export interface LabOut {
  query: string
  query_terms: string[]
  keyword: LabStage
  semantic: LabStage
  fused: LabStage
  reranked: LabStage | null
  embed_ms: number
  total_ms: number
  settings: EffectiveSettings
  index: IndexInfo
  embedding: ModelInfo
  reranker: ModelInfo
}

export interface EvalRun {
  name: string
  recall_at_k: Record<string, number>
  precision_at_k: Record<string, number>
  mrr: number
  ndcg_at_10?: number | null
  latency_ms_p50: number
  latency_ms_p95: number
}

export interface EvalDataset {
  name: string
  description: string
  documents: number
  chunks: number
  queries: number
  embedding_version: string
  reranker: string | null
  indexing_chunks_per_second: number
  runs: EvalRun[]
}

export interface EvalReport {
  generated_at: string
  git_commit: string | null
  hardware: string
  command: string
  datasets: EvalDataset[]
}
