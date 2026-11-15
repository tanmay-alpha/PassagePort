import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { useId, useMemo, useState } from 'react'

import type { LabOut } from '@/api/types'
import { SegmentedControl } from '@/components/ui/Form'
import { cx } from '@/lib/cx'
import { buildRankChart, type ChartSeries, type RankChartData } from '@/lib/rankChart'

const PALETTE_SIZE = 6
const WIDTH = 720
const LEFT = 34
const RIGHT = 190
const TOP = 34
const ROW = 26
const LABEL_CHARS = 26

function seriesColor(series: ChartSeries): string {
  return `var(--pp-chart-${(series.colorIndex % PALETTE_SIZE) + 1})`
}

function shorten(text: string): string {
  return text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text
}

export interface RankChartProps {
  data: LabOut
  /** The passage pointed at here or in the stage columns. */
  activeId: string | null
  onActive: (chunkId: string | null) => void
  onOpen: (chunkId: string) => void
}

type View = 'chart' | 'table'

/** Rank of every passage across keyword → semantic → fused → reranked, as a bump chart or table. */
export function RankChart({ data, activeId, onActive, onOpen }: RankChartProps) {
  const chart = useMemo(() => buildRankChart(data), [data])
  const [view, setView] = useState<View>('chart')
  if (chart.series.length === 0) return null
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-ink-2">
          Each line is one passage; its height is the rank it got from each stage. Lines that cross are passages the stages disagree on.
        </p>
        <SegmentedControl
          label="Rank movement view"
          value={view}
          onValueChange={setView}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </div>
      {view === 'chart' ? (
        <BumpChart chart={chart} activeId={activeId} onActive={onActive} />
      ) : (
        <RankTable chart={chart} activeId={activeId} onActive={onActive} onOpen={onOpen} />
      )}
    </div>
  )
}

function BumpChart({ chart, activeId, onActive }: { chart: RankChartData; activeId: string | null; onActive: (id: string | null) => void }) {
  const titleId = useId()
  const { stages, series, maxRank } = chart
  const height = TOP + maxRank * ROW + 10
  const step = stages.length > 1 ? (WIDTH - LEFT - RIGHT) / (stages.length - 1) : 0
  const x = (stage: number) => LEFT + stage * step
  const y = (rank: number) => TOP + (rank - 0.5) * ROW
  const last = stages.length - 1

  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface p-3" data-testid="rank-chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-labelledby={titleId}
        className="block h-auto w-full min-w-[540px] font-sans"
        onMouseLeave={() => onActive(null)}
      >
        <title id={titleId}>
          {`Rank of ${series.length} passages across the ${stages.map((stage) => stage.label.toLowerCase()).join(', ')} stages. The table view lists the exact ranks.`}
        </title>
        {Array.from({ length: maxRank }, (_, index) => (
          <g key={index}>
            <line x1={LEFT - 6} x2={x(last)} y1={y(index + 1)} y2={y(index + 1)} stroke="var(--pp-line)" strokeWidth={1} strokeDasharray="2 4" />
            <text x={LEFT - 12} y={y(index + 1)} dy="0.35em" textAnchor="end" fontSize={11} fill="var(--pp-ink-3)" className="tabular-nums">
              {index + 1}
            </text>
          </g>
        ))}
        {stages.map((stage, index) => (
          <g key={stage.key}>
            <line x1={x(index)} x2={x(index)} y1={TOP - 6} y2={height - 6} stroke="var(--pp-line-strong)" strokeWidth={1} />
            <text x={x(index)} y={14} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--pp-ink)">
              {stage.label}
            </text>
            <text x={x(index)} y={27} textAnchor="middle" fontSize={10} fill="var(--pp-ink-3)">
              {`${stage.size} results`}
            </text>
          </g>
        ))}
        {series.map((item) => {
          const active = item.chunkId === activeId
          const dimmed = activeId !== null && !active
          const color = seriesColor(item)
          const present = item.ranks.flatMap((rank, stage) => (rank === null ? [] : [{ stage, rank }]))
          const segments = present.slice(1).map((point, index) => {
            const from = present[index]
            const x1 = x(from.stage)
            const x2 = x(point.stage)
            const mid = (x1 + x2) / 2
            return {
              key: `${from.stage}-${point.stage}`,
              d: `M ${x1} ${y(from.rank)} C ${mid} ${y(from.rank)}, ${mid} ${y(point.rank)}, ${x2} ${y(point.rank)}`,
              gap: point.stage - from.stage > 1,
            }
          })
          const finalRank = item.ranks[last]
          return (
            <g
              key={item.chunkId}
              data-series={item.chunkId}
              onMouseEnter={() => onActive(item.chunkId)}
              opacity={dimmed ? 0.18 : 1}
              className="transition-opacity duration-150"
            >
              {segments.map((segment) => (
                <g key={segment.key}>
                  <path d={segment.d} fill="none" stroke="transparent" strokeWidth={12} />
                  <path
                    d={segment.d}
                    fill="none"
                    stroke={color}
                    strokeWidth={active ? 3.5 : 2}
                    strokeLinecap="round"
                    strokeDasharray={segment.gap ? '4 5' : undefined}
                  />
                </g>
              ))}
              {present.map((point) => (
                <circle
                  key={point.stage}
                  cx={x(point.stage)}
                  cy={y(point.rank)}
                  r={active ? 5.5 : 4.5}
                  fill={point.stage === last ? color : 'var(--pp-surface)'}
                  stroke={color}
                  strokeWidth={2}
                />
              ))}
              {finalRank !== null ? (
                <text
                  x={x(last) + 12}
                  y={y(finalRank)}
                  dy="0.35em"
                  fontSize={11.5}
                  fontWeight={active ? 600 : 400}
                  fill={active ? 'var(--pp-ink)' : 'var(--pp-ink-2)'}
                >
                  {shorten(item.label)}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      <p className="mt-2 text-xs text-ink-3">
        Hollow points: rank inside a stage. Filled points: final rank. Dashed lines skip a stage that did not return the passage.
      </p>
    </div>
  )
}

function Movement({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-3">—</span>
  if (value === 0)
    return (
      <span className="inline-flex items-center gap-0.5 text-ink-3">
        <Minus size={12} aria-hidden="true" />
        <span className="sr-only">unchanged</span>
      </span>
    )
  const up = value > 0
  return (
    <span className={cx('inline-flex items-center gap-0.5 font-medium', up ? 'text-success' : 'text-danger')}>
      {up ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}
      <span className="sr-only">{up ? 'up' : 'down'}</span>
      {Math.abs(value)}
    </span>
  )
}

interface RankTableProps {
  chart: RankChartData
  activeId: string | null
  onActive: (id: string | null) => void
  onOpen: (chunkId: string) => void
}

function RankTable({ chart, activeId, onActive, onOpen }: RankTableProps) {
  const { stages, series } = chart
  const reranked = stages.at(-1)?.key === 'reranked'
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface" data-testid="rank-table">
      <table className="w-full border-collapse text-left text-[13px]">
        <caption className="sr-only">Rank of each passage at each retrieval stage</caption>
        <thead>
          <tr className="border-b border-line text-xs text-ink-3">
            <th scope="col" className="px-3 py-2 font-medium">
              Passage
            </th>
            {stages.map((stage) => (
              <th key={stage.key} scope="col" className="px-3 py-2 text-right font-medium">
                {stage.label}
              </th>
            ))}
            {reranked ? (
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Rerank moved it
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-line tabular-nums">
          {series.map((item) => (
            <tr key={item.chunkId} className={cx(item.chunkId === activeId && 'bg-accent-soft')}>
              <th scope="row" className="max-w-72 px-3 py-1.5 font-normal">
                <button
                  type="button"
                  onClick={() => onOpen(item.chunkId)}
                  onFocus={() => onActive(item.chunkId)}
                  onBlur={() => onActive(null)}
                  className="flex max-w-full items-center gap-2 rounded-sm text-left text-ink hover:text-accent"
                >
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(item) }} aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </button>
              </th>
              {item.ranks.map((rank, index) => (
                <td key={stages[index].key} className="px-3 py-1.5 text-right text-ink">
                  {rank === null ? (
                    <span className="text-ink-3">
                      —<span className="sr-only">not in this list</span>
                    </span>
                  ) : (
                    `#${rank}`
                  )}
                </td>
              ))}
              {reranked ? (
                <td className="px-3 py-1.5 text-right">
                  <Movement value={item.lastMove} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
