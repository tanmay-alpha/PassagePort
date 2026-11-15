import type { Hit, LabOut } from '@/api/types'

export type StageKey = 'keyword' | 'semantic' | 'fused' | 'reranked'

export const STAGE_LABELS: Record<StageKey, string> = {
  keyword: 'Keyword',
  semantic: 'Semantic',
  fused: 'Fused',
  reranked: 'Reranked',
}

export interface ChartStage {
  key: StageKey
  label: string
  /** Number of passages the stage returned. */
  size: number
}

export interface ChartSeries {
  chunkId: string
  documentId: string
  label: string
  /** Rank in each stage of `stages`, same order; null where the passage is not in that list. */
  ranks: Array<number | null>
  /** Rank in the last stage that ran; null when the passage is not in that list. */
  finalRank: number | null
  /** Fused rank minus final rank: positive means the last stage moved it up. */
  lastMove: number | null
  /** Index into the document palette, stable per document within one chart. */
  colorIndex: number
}

export interface RankChartData {
  stages: ChartStage[]
  series: ChartSeries[]
  /** Deepest rank shown in any stage. */
  maxRank: number
}

/**
 * Rank of every passage at every stage that ran, for the bump chart and its table. Series are
 * ordered by their final rank, then by best rank elsewhere, so the table reads top-down.
 */
export function buildRankChart(data: LabOut): RankChartData {
  const lists: Array<{ key: StageKey; results: Hit[] }> = [
    { key: 'keyword', results: data.keyword.results },
    { key: 'semantic', results: data.semantic.results },
    { key: 'fused', results: data.fused.results },
  ]
  if (data.reranked) lists.push({ key: 'reranked', results: data.reranked.results })
  const stages = lists.map(({ key, results }) => ({ key, label: STAGE_LABELS[key], size: results.length }))

  const byChunk = new Map<string, { hit: Hit; ranks: Array<number | null> }>()
  lists.forEach(({ results }, stageIndex) => {
    for (const hit of results) {
      let entry = byChunk.get(hit.chunk_id)
      if (!entry) {
        entry = { hit, ranks: lists.map(() => null) }
        byChunk.set(hit.chunk_id, entry)
      }
      entry.ranks[stageIndex] = hit.rank
    }
  })

  const documentColors = new Map<string, number>()
  const last = lists.length - 1
  const fusedIndex = 2
  const series: ChartSeries[] = [...byChunk.values()].map(({ hit, ranks }) => {
    if (!documentColors.has(hit.document_id)) documentColors.set(hit.document_id, documentColors.size)
    const finalRank = ranks[last]
    const fusedRank = ranks[fusedIndex]
    return {
      chunkId: hit.chunk_id,
      documentId: hit.document_id,
      label: `${hit.document_title} · ${hit.page_label}`,
      ranks,
      finalRank,
      lastMove: last !== fusedIndex && finalRank !== null && fusedRank !== null ? fusedRank - finalRank : null,
      colorIndex: documentColors.get(hit.document_id) ?? 0,
    }
  })
  const best = (ranks: Array<number | null>) => Math.min(...ranks.map((rank) => rank ?? Number.POSITIVE_INFINITY))
  series.sort((a, b) => (a.finalRank ?? Infinity) - (b.finalRank ?? Infinity) || best(a.ranks) - best(b.ranks))

  const maxRank = Math.max(1, ...stages.map((stage) => stage.size))
  return { stages, series, maxRank }
}
