import { describe, expect, it } from 'vitest'

import { makeHit, makeLab } from '@/test/fixtures'

import { buildRankChart } from './rankChart'

describe('buildRankChart', () => {
  it('lines up every passage’s rank per stage and orders series by final rank', () => {
    const chart = buildRankChart(makeLab())

    expect(chart.stages.map((stage) => [stage.key, stage.size])).toEqual([
      ['keyword', 2],
      ['semantic', 2],
      ['fused', 2],
      ['reranked', 2],
    ])
    expect(chart.maxRank).toBe(2)
    expect(chart.series.map(({ chunkId, ranks, finalRank, lastMove }) => ({ chunkId, ranks, finalRank, lastMove }))).toEqual([
      // ch2: keyword #2, semantic #1, fused #2, reranked #1 → the reranker moved it up one place.
      { chunkId: 'ch2', ranks: [2, 1, 2, 1], finalRank: 1, lastMove: 1 },
      { chunkId: 'ch1', ranks: [1, 2, 1, 2], finalRank: 2, lastMove: -1 },
    ])
    expect(chart.series[0].label).toBe('Master agreement · Scope')
  })

  it('leaves gaps for passages a stage did not return and skips a stage that did not run', () => {
    const onlyKeyword = makeHit({ chunk_id: 'kw', document_id: 'd2', rank: 1 })
    const both = makeHit({ chunk_id: 'both', rank: 2 })
    const chart = buildRankChart(
      makeLab({
        keyword: { results: [onlyKeyword, both], ms: 1 },
        semantic: { results: [{ ...both, rank: 1 }], ms: 1 },
        fused: { results: [{ ...both, rank: 1 }, { ...onlyKeyword, rank: 2 }], ms: 1 },
        reranked: null,
      }),
    )

    expect(chart.stages.map((stage) => stage.key)).toEqual(['keyword', 'semantic', 'fused'])
    expect(chart.series.map(({ chunkId, ranks, finalRank, lastMove }) => ({ chunkId, ranks, finalRank, lastMove }))).toEqual([
      { chunkId: 'both', ranks: [2, 1, 1], finalRank: 1, lastMove: null },
      { chunkId: 'kw', ranks: [1, null, 2], finalRank: 2, lastMove: null },
    ])
    // Colours follow documents, in order of first appearance.
    expect(chart.series.find((series) => series.chunkId === 'kw')?.colorIndex).toBe(0)
    expect(chart.series.find((series) => series.chunkId === 'both')?.colorIndex).toBe(1)
  })
})
