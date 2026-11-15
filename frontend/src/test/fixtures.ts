/** Contract-shaped test data. Every builder returns a complete object matching api/types.ts. */
import type {
  AskOut,
  CollectionOut,
  CompareOut,
  DocumentOut,
  EffectiveSettings,
  EvalReport,
  Evidence,
  Hit,
  LabOut,
  ModelInfo,
  SearchOut,
  SessionOut,
  SystemOut,
} from '@/api/types'

const NOW = '2026-05-01T10:00:00Z'

export function makeSession(overrides: Partial<SessionOut> = {}): SessionOut {
  return {
    auth_mode: 'local',
    authenticated: true,
    user: { id: 'u_local', username: 'local', is_guest: false },
    signup_enabled: false,
    signup_requires_code: false,
    guests_enabled: false,
    ...overrides,
  }
}

export const signedOutSession = (overrides: Partial<SessionOut> = {}): SessionOut =>
  makeSession({ auth_mode: 'accounts', authenticated: false, user: null, signup_enabled: true, ...overrides })

export const embeddingModel: ModelInfo = { backend: 'fastembed', model: 'BAAI/bge-small-en-v1.5', dimensions: 384, loaded: true, enabled: true }
export const rerankerModel: ModelInfo = { backend: 'fastembed', model: 'Xenova/ms-marco-MiniLM-L-6-v2', dimensions: null, loaded: false, enabled: true }

export function makeSystem(overrides: Partial<SystemOut> = {}): SystemOut {
  return {
    version: '1.0.0',
    auth_mode: 'local',
    database: 'sqlite',
    blob_backend: 'fs',
    embedding: embeddingModel,
    reranker: rerankerModel,
    llm_configured: false,
    llm_model: null,
    limits: {
      max_upload_bytes: 1024 * 1024,
      allowed_extensions: ['.pdf', '.txt', '.md', '.docx'],
      max_documents: 300,
      max_storage_bytes: 500 * 1024 * 1024,
      max_query_chars: 1000,
    },
    search_defaults: {
      mode: 'hybrid',
      top_k: 8,
      candidates: 30,
      rrf_k: 60,
      lexical_weight: 1,
      vector_weight: 1,
      rerank: true,
      rerank_candidates: 20,
      bm25_k1: 1.2,
      bm25_b: 0.75,
      chunk_max_tokens: 256,
    },
    usage: { collections: 1, documents: 3, chunks: 42, storage_bytes: 2048 },
    pending_jobs: 0,
    ...overrides,
  }
}

export function makeCollection(overrides: Partial<CollectionOut> = {}): CollectionOut {
  return {
    id: 'c1',
    name: 'Contracts',
    description: 'Supplier agreements',
    created_at: NOW,
    updated_at: NOW,
    document_count: 3,
    indexed_count: 2,
    processing_count: 0,
    failed_count: 1,
    chunk_count: 42,
    size_bytes: 2048,
    ...overrides,
  }
}

export function makeDocument(overrides: Partial<DocumentOut> = {}): DocumentOut {
  return {
    id: 'd1',
    collection_id: 'c1',
    title: 'Master agreement',
    filename: 'master-agreement.md',
    kind: 'md',
    locator_kind: 'section',
    size_bytes: 1536,
    sha256: 'a'.repeat(64),
    status: 'indexed',
    error: null,
    page_count: 3,
    chunk_count: 12,
    stale: false,
    created_at: NOW,
    updated_at: NOW,
    indexed_at: NOW,
    ...overrides,
  }
}

export function makeHit(overrides: Partial<Hit> = {}): Hit {
  return {
    chunk_id: 'ch1',
    document_id: 'd1',
    document_title: 'Master agreement',
    document_kind: 'md',
    locator_kind: 'section',
    page_number: 2,
    page_label: 'Termination',
    char_start: 0,
    char_end: 47,
    text: 'Either party may terminate with 30 days notice.',
    rank: 1,
    scores: { keyword: { rank: 1, score: 7.42 }, semantic: { rank: 2, score: 0.713 }, fused: 0.0325, rerank: 4.2 },
    matched_terms: ['terminate', 'notice'],
    ...overrides,
  }
}

export function makeEvidence(ref: number, overrides: Partial<Evidence> = {}): Evidence {
  return { ...makeHit({ chunk_id: `ev${ref}`, rank: ref }), ref, ...overrides }
}

export const effectiveSettings: EffectiveSettings = {
  mode: 'hybrid',
  top_k: 8,
  candidates: 30,
  rrf_k: 60,
  lexical_weight: 1,
  vector_weight: 1,
  reranked: true,
  rerank_candidates: 20,
  bm25_k1: 1.2,
  bm25_b: 0.75,
  embedding_version: 'fastembed:BAAI/bge-small-en-v1.5:384',
  reranker: 'Xenova/ms-marco-MiniLM-L-6-v2',
  index_version: 7,
}

export function makeSearch(overrides: Partial<SearchOut> = {}): SearchOut {
  return {
    query: 'termination notice',
    results: [
      makeHit(),
      makeHit({
        chunk_id: 'ch2',
        document_id: 'd2',
        document_title: 'Service addendum',
        page_number: 1,
        page_label: 'Scope',
        text: 'Notice must be given in writing.',
        rank: 2,
        scores: { keyword: null, semantic: { rank: 1, score: 0.801 }, fused: 0.0164, rerank: 1.1 },
        matched_terms: ['notice'],
      }),
    ],
    low_confidence: false,
    notice: null,
    settings: effectiveSettings,
    timings_ms: { embed: 3.1, keyword: 0.6, semantic: 1.2, fuse: 0.1, rerank: 20.5, total: 25.5 },
    ...overrides,
  }
}

export function makeAsk(overrides: Partial<AskOut> = {}): AskOut {
  return {
    question: 'What is the notice period?',
    mode: 'extractive',
    segments: [{ text: 'Either party may terminate with 30 days notice.', citations: [1], supported: true }],
    evidence: [makeEvidence(1), makeEvidence(2, { text: 'Notice must be given in writing.', page_label: 'Scope' })],
    notice: null,
    llm_model: null,
    checks: ['Every sentence is copied verbatim from a cited passage.'],
    timings_ms: { retrieve: 12, total: 14 },
    ...overrides,
  }
}

export function makeCompare(overrides: Partial<CompareOut> = {}): CompareOut {
  const a = makeEvidence(1, { document_id: 'd1', document_title: 'Master agreement', text: 'Either party may terminate with 30 days notice.' })
  const b = makeEvidence(2, { document_id: 'd2', document_title: 'Service addendum', text: 'Either party may terminate with 60 days notice.' })
  const lone = makeEvidence(3, { document_id: 'd1', document_title: 'Master agreement', text: 'Fees are payable within 14 days.', page_label: 'Fees' })
  return {
    question: 'notice period',
    documents: [
      { document_id: 'd1', title: 'Master agreement', has_evidence: true, evidence: [a, lone] },
      { document_id: 'd2', title: 'Service addendum', has_evidence: true, evidence: [b] },
      { document_id: 'd3', title: 'Pricing sheet', has_evidence: false, evidence: [] },
    ],
    alignments: [
      {
        passages: [
          { document_id: 'd1', ref: 1 },
          { document_id: 'd2', ref: 2 },
        ],
        similarity: 0.93,
        shared_sentences: ['Termination requires written notice.'],
        unique_sentences: { d1: ['Notice may be sent by email.'], d2: [] },
        numeric_differences: [{ context: 'terminate with … days notice', values: { d1: '30', d2: '60' } }],
        identical: false,
      },
    ],
    unaligned: [{ document_id: 'd1', ref: 3 }],
    interpretation: null,
    llm_model: null,
    notice: null,
    timings_ms: { total: 31 },
    ...overrides,
  }
}

export function makeLab(overrides: Partial<LabOut> = {}): LabOut {
  const first = makeHit({ chunk_id: 'ch1', rank: 1 })
  const second = makeHit({ chunk_id: 'ch2', rank: 2, text: 'Notice must be given in writing.', page_label: 'Scope' })
  return {
    query: 'termination notice',
    query_terms: ['termination', 'notice'],
    keyword: { results: [first, second], ms: 0.8 },
    semantic: { results: [{ ...second, rank: 1 }, { ...first, rank: 2 }], ms: 2.4 },
    fused: { results: [first, second], ms: 0.1 },
    reranked: { results: [{ ...second, rank: 1 }, { ...first, rank: 2 }], ms: 18 },
    embed_ms: 3.5,
    total_ms: 25,
    settings: { ...effectiveSettings, top_k: 10 },
    index: {
      chunks: 42,
      documents: 3,
      vocabulary: 512,
      average_chunk_tokens: 118.4,
      index_version: 7,
      build_ms: 6.2,
      cached: true,
      vector_search: 'exact cosine (brute force)',
      tokenizer: 'unicode words, lowercased',
    },
    embedding: embeddingModel,
    reranker: rerankerModel,
    ...overrides,
  }
}

export function makeEvalReport(): EvalReport {
  return {
    generated_at: NOW,
    git_commit: 'abc1234',
    hardware: '8-core laptop CPU',
    command: 'uv run python -m passageport.evaluation.run',
    datasets: [
      {
        name: 'handbook-qa',
        description: 'Questions over a staff handbook.',
        documents: 12,
        chunks: 340,
        queries: 50,
        embedding_version: 'fastembed:BAAI/bge-small-en-v1.5:384',
        reranker: 'Xenova/ms-marco-MiniLM-L-6-v2',
        indexing_chunks_per_second: 85.5,
        runs: [
          { name: 'keyword', recall_at_k: { '1': 0.52, '5': 0.8 }, precision_at_k: { '1': 0.52, '5': 0.16 }, mrr: 0.641, ndcg_at_10: null, latency_ms_p50: 1.2, latency_ms_p95: 2.5 },
          { name: 'hybrid+rerank', recall_at_k: { '1': 0.74, '5': 0.94 }, precision_at_k: { '1': 0.74, '5': 0.19 }, mrr: 0.827, ndcg_at_10: 0.86, latency_ms_p50: 41, latency_ms_p95: 77 },
        ],
      },
    ],
  }
}
