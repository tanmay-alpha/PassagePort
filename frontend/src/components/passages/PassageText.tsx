import { FileText } from 'lucide-react'
import { useMemo } from 'react'

import type { Hit, Passage, SearchMode } from '@/api/types'
import { Tooltip } from '@/components/ui/Tooltip'
import { cx } from '@/lib/cx'
import { formatScore, kindLabel } from '@/lib/format'
import { highlightTerms } from '@/lib/text'

/** Passage text in the reading face, with the keyword retriever's matched terms marked. */
export function PassageText({ text, terms = [], className }: { text: string; terms?: readonly string[]; className?: string }) {
  const parts = useMemo(() => highlightTerms(text, terms), [text, terms])
  return (
    <span className={cx('pp-passage block whitespace-pre-line text-ink', className)}>
      {parts.map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text))}
    </span>
  )
}

/** "Document title · Page 3" header shared by hits, evidence and comparison cells. */
export function PassageSource({ passage, className }: { passage: Passage; className?: string }) {
  return (
    <span className={cx('flex min-w-0 items-center gap-1.5 text-[13px]', className)}>
      <FileText size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
      <span className="truncate font-medium text-ink">{passage.document_title}</span>
      <span className="shrink-0 text-ink-3" aria-hidden="true">
        ·
      </span>
      <span className="shrink-0 text-ink-2">{passage.page_label}</span>
      <span className="sr-only">{`, ${kindLabel(passage.document_kind)}`}</span>
    </span>
  )
}

interface Metric {
  key: string
  label: string
  explanation: string
}

const NOT_KEYWORD = 'This passage contains none of the query terms; the keyword retriever did not return it.'
const NOT_SEMANTIC = 'This passage was not among the semantic retriever’s candidates.'

/** `any`: show whichever scores are present (evidence lists, where the mode is the server's). */
export type RetrievalMode = SearchMode | 'any'

/** The scores the server actually computed for this hit, phrased for the search mode. */
function metricsFor(hit: Hit, mode: RetrievalMode): Metric[] {
  const { keyword, semantic, fused, rerank } = hit.scores
  const metrics: Metric[] = []
  if (keyword) {
    metrics.push({
      key: 'keyword',
      label: `Keyword #${keyword.rank} · BM25 ${formatScore(keyword.score, 2)}`,
      explanation:
        'Rank among keyword matches. BM25 rewards rare query terms that occur often in a short passage; the value is only comparable within this search.',
    })
  } else if (mode === 'hybrid') {
    metrics.push({ key: 'keyword', label: 'No keyword match', explanation: NOT_KEYWORD })
  }
  if (semantic) {
    metrics.push({
      key: 'semantic',
      label: `Semantic #${semantic.rank} · similarity ${formatScore(semantic.score)}`,
      explanation:
        'Rank among semantic matches. Similarity is the cosine between the query and passage embeddings (1 means identical direction). It is not a probability.',
    })
  } else if (mode === 'hybrid') {
    metrics.push({ key: 'semantic', label: 'No semantic match', explanation: NOT_SEMANTIC })
  }
  if ((mode === 'hybrid' || mode === 'any') && fused !== null && fused !== undefined) {
    metrics.push({
      key: 'fused',
      label: `Fused ${formatScore(fused, 4)}`,
      explanation:
        'Weighted reciprocal-rank fusion of the keyword and semantic ranks. Passages ranked well by both lists score highest.',
    })
  }
  if (rerank !== null && rerank !== undefined) {
    metrics.push({
      key: 'rerank',
      label: `Rerank ${formatScore(rerank, 2)}`,
      explanation:
        'Raw score from the cross-encoder that read the query and passage together and set the final order. Higher is more relevant; it is not a percentage.',
    })
  }
  return metrics
}

/** One compact, honest line explaining why a hit is where it is. */
export function RetrievalLine({ hit, mode, className }: { hit: Hit; mode: RetrievalMode; className?: string }) {
  const metrics = metricsFor(hit, mode)
  if (metrics.length === 0) return null
  return (
    <ul aria-label="How this passage was retrieved" className={cx('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3', className)}>
      {metrics.map((metric) => (
        <li key={metric.key}>
          <Tooltip content={metric.explanation}>
            <button
              type="button"
              className="cursor-help rounded-sm tabular-nums underline decoration-line-strong decoration-dotted underline-offset-2 hover:text-ink-2"
            >
              {metric.label}
            </button>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}
