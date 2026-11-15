import { type FormEvent, type ReactNode, useMemo, useState } from 'react'

import { errorMessage } from '@/api/client'
import { useDocuments, useEvaluation, useLabSearch, useSystem } from '@/api/queries'
import type { CollectionOut, EvalDataset, EvalReport, Hit, LabIn, LabOut, LabStage, SystemOut } from '@/api/types'
import { DocumentFilter } from '@/components/documents/DocumentFilter'
import { RankChart } from '@/components/lab/RankChart'
import { PreviewLayout } from '@/components/passages/PreviewLayout'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState, Notice, Skeleton, Spinner } from '@/components/ui/Feedback'
import { Field, Input, Switch } from '@/components/ui/Form'
import { Page, PageHeader, SectionHeading, WorkspaceBoundary } from '@/components/ui/Page'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { cx } from '@/lib/cx'
import { formatCount, formatDateTime, formatMs, formatScore } from '@/lib/format'
import { useDocumentTitle, useMediaQuery, WIDE_QUERY } from '@/lib/hooks'
import { useUrlParams } from '@/lib/params'
import type { StageKey } from '@/lib/rankChart'
import { useSelectedPassage } from '@/lib/selection'

export function Component() {
  return <WorkspaceBoundary>{(collection) => <LabScreen key={collection.id} collection={collection} />}</WorkspaceBoundary>
}

interface StageInfo {
  key: StageKey
  title: string
  /** Short label used in the rank trace. */
  short: string
  description: string
  score: (hit: Hit) => string | null
}

const STAGES: StageInfo[] = [
  {
    key: 'keyword',
    title: 'Keyword (BM25)',
    short: 'Keyword',
    description: 'Passages containing the query’s words. Rare words and repeated matches in a short passage score higher.',
    score: (hit) => (hit.scores.keyword ? `BM25 ${formatScore(hit.scores.keyword.score, 2)}` : null),
  },
  {
    key: 'semantic',
    title: 'Semantic',
    short: 'Semantic',
    description: 'Passages whose embedding points the same way as the query’s, so paraphrases match without shared words.',
    score: (hit) => (hit.scores.semantic ? `cosine ${formatScore(hit.scores.semantic.score)}` : null),
  },
  {
    key: 'fused',
    title: 'Fused',
    short: 'Fused',
    description: 'Both lists merged by weighted reciprocal-rank fusion: a passage ranked well by either list rises, by both rises most.',
    score: (hit) => (hit.scores.fused !== null && hit.scores.fused !== undefined ? `RRF ${formatScore(hit.scores.fused, 4)}` : null),
  },
  {
    key: 'reranked',
    title: 'Reranked',
    short: 'Reranked',
    description: 'A cross-encoder reads the query and each fused candidate together and sets the final order.',
    score: (hit) => (hit.scores.rerank !== null && hit.scores.rerank !== undefined ? `score ${formatScore(hit.scores.rerank, 2)}` : null),
  },
]

interface Controls {
  topK: string
  candidates: string
  rrfK: string
  lexicalWeight: string
  vectorWeight: string
  rerank: boolean
}

/** Empty fields mean "use the server default"; the placeholders show what that is. */
const SERVER_DEFAULTS: Controls = { topK: '10', candidates: '', rrfK: '', lexicalWeight: '', vectorWeight: '', rerank: true }

interface NumberSpec {
  field: Exclude<keyof Controls, 'rerank'>
  label: string
  hint: string
  min: number
  max: number
  integer: boolean
  placeholder: (system: SystemOut) => string
}

// Ranges mirror LabIn in the API contract.
const NUMBER_FIELDS: NumberSpec[] = [
  { field: 'topK', label: 'Results per stage', hint: '1–30', min: 1, max: 30, integer: true, placeholder: () => '10' },
  {
    field: 'candidates',
    label: 'Candidates per retriever',
    hint: '1–200',
    min: 1,
    max: 200,
    integer: true,
    placeholder: (system) => String(system.search_defaults.candidates),
  },
  {
    field: 'rrfK',
    label: 'RRF k',
    hint: '1–1000. Higher flattens rank differences.',
    min: 1,
    max: 1000,
    integer: true,
    placeholder: (system) => String(system.search_defaults.rrf_k),
  },
  {
    field: 'lexicalWeight',
    label: 'Keyword weight',
    hint: '0–10',
    min: 0,
    max: 10,
    integer: false,
    placeholder: (system) => String(system.search_defaults.lexical_weight),
  },
  {
    field: 'vectorWeight',
    label: 'Semantic weight',
    hint: '0–10',
    min: 0,
    max: 10,
    integer: false,
    placeholder: (system) => String(system.search_defaults.vector_weight),
  },
]

type ControlErrors = Partial<Record<NumberSpec['field'], string>>

function parseControls(controls: Controls): { values: Partial<Record<NumberSpec['field'], number>>; errors: ControlErrors } {
  const values: Partial<Record<NumberSpec['field'], number>> = {}
  const errors: ControlErrors = {}
  for (const spec of NUMBER_FIELDS) {
    const raw = controls[spec.field].trim()
    if (raw === '') continue
    const value = Number(raw)
    if (!Number.isFinite(value) || value < spec.min || value > spec.max || (spec.integer && !Number.isInteger(value))) {
      errors[spec.field] = `Enter ${spec.integer ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max}.`
    } else {
      values[spec.field] = value
    }
  }
  return { values, errors }
}

function LabScreen({ collection }: { collection: CollectionOut }) {
  useDocumentTitle(`Search Lab · ${collection.name}`)
  const [params, patch] = useUrlParams()
  const system = useSystem()
  const documents = useDocuments(collection.id)
  const [query, setQuery] = useState('')
  const [controls, setControls] = useState<Controls>(SERVER_DEFAULTS)
  const [documentIds, setDocumentIds] = useState<string[]>([])
  const [errors, setErrors] = useState<ControlErrors>({})
  const [submitted, setSubmitted] = useState<LabIn | null>(null)
  const lab = useLabSearch(submitted)
  const hitId = params.get('hit')

  // `?q=` (from the command menu or a sample suggestion) runs that query with default settings.
  const qParam = params.get('q')
  const [seenQ, setSeenQ] = useState<string | null>(null)
  if (qParam !== seenQ) {
    setSeenQ(qParam)
    const text = qParam?.trim() ?? ''
    if (text !== '') {
      setQuery(text)
      setControls(SERVER_DEFAULTS)
      setDocumentIds([])
      setErrors({})
      setSubmitted({ query: text, collection_id: collection.id, top_k: 10, rerank: true })
    }
  }

  const candidates = useMemo(() => {
    const data = lab.data
    return data ? [...data.keyword.results, ...data.semantic.results, ...data.fused.results, ...(data.reranked?.results ?? [])] : undefined
  }, [lab.data])
  const { selected } = useSelectedPassage(hitId, candidates, submitted === null || !lab.isPending)

  const indexed = useMemo(() => (documents.data ?? []).filter((document) => document.status === 'indexed'), [documents.data])
  const rerankerAvailable = system.data ? system.data.reranker.enabled !== false : true

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const text = query.trim()
    const parsed = parseControls(controls)
    setErrors(parsed.errors)
    if (text === '' || Object.keys(parsed.errors).length > 0) return
    setSeenQ(text)
    patch({ q: text, hit: null }, { replace: true })
    setSubmitted({
      query: text,
      collection_id: collection.id,
      document_ids: documentIds.length > 0 ? documentIds : null,
      top_k: parsed.values.topK ?? 10,
      candidates: parsed.values.candidates ?? null,
      rrf_k: parsed.values.rrfK ?? null,
      lexical_weight: parsed.values.lexicalWeight ?? null,
      vector_weight: parsed.values.vectorWeight ?? null,
      rerank: controls.rerank && rerankerAvailable,
    })
  }

  return (
    <PreviewLayout passage={selected} onClose={() => patch({ hit: null })} label="Search Lab">
      <Page className="max-w-7xl">
        <PageHeader
          eyebrow={collection.name}
          title="Search Lab"
          description="Run one query through every retrieval stage and see how each one ranks the same passages, how long it takes and which settings produced the result."
        />

        <form onSubmit={onSubmit} noValidate className="rounded-lg border border-line bg-surface p-4">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Query to inspect"
              placeholder="Query to inspect"
              maxLength={system.data?.limits.max_query_chars}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="primary" loading={lab.isFetching} disabled={query.trim() === ''}>
              Run
            </Button>
          </div>
          <div className="mt-4 grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
            {NUMBER_FIELDS.map((spec) => (
              <Field key={spec.field} label={spec.label} hint={spec.hint} error={errors[spec.field]}>
                {(control) => (
                  <Input
                    {...control}
                    inputMode={spec.integer ? 'numeric' : 'decimal'}
                    value={controls[spec.field]}
                    placeholder={system.data ? spec.placeholder(system.data) : undefined}
                    onChange={(event) => setControls((current) => ({ ...current, [spec.field]: event.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className={cx('flex items-center gap-2 text-[13px]', rerankerAvailable ? 'text-ink' : 'text-ink-3')}>
              <Switch
                checked={controls.rerank && rerankerAvailable}
                disabled={!rerankerAvailable}
                onCheckedChange={(rerank) => setControls((current) => ({ ...current, rerank }))}
              />
              Rerank
            </label>
            {rerankerAvailable ? null : <p className="text-[13px] text-ink-3">Unavailable: this server runs without a reranker model.</p>}
            <DocumentFilter documents={indexed} selected={documentIds} onChange={setDocumentIds} />
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setControls(SERVER_DEFAULTS)
                setErrors({})
              }}
            >
              Reset to server defaults
            </Button>
          </div>
        </form>

        <div className="mt-6">
          {submitted === null ? (
            <p className="rounded-lg border border-line px-5 py-4 text-[13px] text-ink-2">
              Enter a query to see the keyword, semantic, fused and reranked rankings side by side. Empty settings use the
              server defaults shown as placeholders.
            </p>
          ) : lab.isPending ? (
            <div className="rounded-lg border border-line p-5 text-ink-2">
              <Spinner label="Running all stages…" />
            </div>
          ) : lab.isError ? (
            <Notice
              tone="danger"
              title="The query could not be run."
              action={
                <Button size="sm" onClick={() => void lab.refetch()}>
                  Try again
                </Button>
              }
            >
              {errorMessage(lab.error)}
            </Notice>
          ) : (
            <LabResults
              data={lab.data}
              stale={lab.isPlaceholderData}
              selectedId={selected?.chunk_id ?? null}
              onOpen={(hit) => patch({ hit: hit.chunk_id }, { replace: selected !== null })}
            />
          )}
        </div>

        <Evaluation />
      </Page>
    </PreviewLayout>
  )
}

// ----------------------------------------------------------------------------- results

interface LabResultsProps {
  data: LabOut
  stale: boolean
  selectedId: string | null
  onOpen: (hit: Hit) => void
}

function LabResults({ data, stale, selectedId, onOpen }: LabResultsProps) {
  const wide = useMediaQuery(WIDE_QUERY)
  // The passage under the pointer or keyboard focus, highlighted in every column.
  const [activeId, setActiveId] = useState<string | null>(null)
  const stages = STAGES.map((info) => ({ info, stage: data[info.key] }))
  const traced = activeId ?? selectedId

  const column = (info: StageInfo, stage: LabStage | null) => (
    <StageColumn
      info={info}
      stage={stage}
      tracedId={traced}
      selectedId={selectedId}
      onActive={setActiveId}
      onOpen={onOpen}
    />
  )

  return (
    <div className={cx('space-y-6', stale && 'opacity-60')} aria-busy={stale}>
      <section aria-labelledby="lab-terms">
        <SectionHeading id="lab-terms">Query terms</SectionHeading>
        <p className="mt-1 text-[13px] text-ink-2">What the keyword index searches for after tokenizing “{data.query}”.</p>
        {data.query_terms.length === 0 ? (
          <p className="mt-2 text-[13px] text-warning">No searchable terms remain, so the keyword stage cannot match anything.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Tokenized query terms">
            {data.query_terms.map((term) => (
              <li key={term}>
                <Badge className="font-mono">{term}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lab-movement">
        <SectionHeading id="lab-movement">Rank movement</SectionHeading>
        <RankChart
          data={data}
          activeId={traced}
          onActive={setActiveId}
          onOpen={(chunkId) => {
            const hit = [data.reranked, data.fused, data.semantic, data.keyword]
              .flatMap((stage) => stage?.results ?? [])
              .find((candidate) => candidate.chunk_id === chunkId)
            if (hit) onOpen(hit)
          }}
        />
      </section>

      <Latency data={data} />

      <section aria-labelledby="lab-stages">
        <SectionHeading id="lab-stages">Rankings by stage</SectionHeading>
        <p className="mt-1 text-[13px] text-ink-2">Point at or focus a passage to follow it across the stages.</p>
        <RankTrace data={data} chunkId={traced} />
        {wide ? (
          <div className="mt-3 grid grid-cols-4 gap-3">
            {stages.map(({ info, stage }) => (
              <div key={info.key} className="min-w-0">
                {column(info, stage)}
              </div>
            ))}
          </div>
        ) : (
          <Tabs defaultValue="fused" className="mt-3">
            <TabsList aria-label="Retrieval stage">
              {stages.map(({ info }) => (
                <TabsTrigger key={info.key} value={info.key}>
                  {info.short}
                </TabsTrigger>
              ))}
            </TabsList>
            {stages.map(({ info, stage }) => (
              <TabsContent key={info.key} value={info.key} className="pt-3">
                {column(info, stage)}
              </TabsContent>
            ))}
          </Tabs>
        )}
      </section>

      <Configuration data={data} />
    </div>
  )
}

function rankIn(stage: LabStage | null, chunkId: string): number | null {
  return stage?.results.find((hit) => hit.chunk_id === chunkId)?.rank ?? null
}

/** Where the traced passage sits in each stage, so rank movement is readable at a glance. */
function RankTrace({ data, chunkId }: { data: LabOut; chunkId: string | null }) {
  const hit = chunkId
    ? [data.fused, data.keyword, data.semantic, data.reranked]
        .flatMap((stage) => stage?.results ?? [])
        .find((candidate) => candidate.chunk_id === chunkId)
    : undefined
  return (
    <div className="mt-2 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface px-3 py-1.5 text-[13px]" aria-live="polite">
      {hit && chunkId ? (
        <>
          <span className="max-w-64 truncate font-medium text-ink">
            {hit.document_title} · {hit.page_label}
          </span>
          {STAGES.map((info) => {
            const stage = data[info.key]
            const rank = rankIn(stage, chunkId)
            return (
              <span key={info.key} className="text-ink-2 tabular-nums">
                {info.short} {stage === null ? 'not run' : rank === null ? 'not in list' : `#${rank}`}
              </span>
            )
          })}
        </>
      ) : (
        <span className="text-ink-3">No passage selected.</span>
      )}
    </div>
  )
}

interface StageColumnProps {
  info: StageInfo
  stage: LabStage | null
  tracedId: string | null
  selectedId: string | null
  onActive: (chunkId: string | null) => void
  onOpen: (hit: Hit) => void
}

function StageColumn({ info, stage, tracedId, selectedId, onActive, onOpen }: StageColumnProps) {
  const headingId = `stage-${info.key}`
  return (
    <section aria-labelledby={headingId} className="flex h-full flex-col rounded-lg border border-line bg-surface" data-testid={`stage-${info.key}`}>
      <header className="border-b border-line px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 id={headingId} className="text-[13px] font-semibold text-ink">
            {info.title}
          </h3>
          {stage ? <span className="text-xs text-ink-3 tabular-nums">{formatMs(stage.ms)}</span> : null}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink-2">{info.description}</p>
      </header>
      {stage === null ? (
        <p className="px-3 py-4 text-[13px] text-ink-3">
          Reranking was not run for this query: it is switched off or the server has no reranker.
        </p>
      ) : stage.results.length === 0 ? (
        <p className="px-3 py-4 text-[13px] text-ink-3">No passages.</p>
      ) : (
        <ol className="divide-y divide-line">
          {stage.results.map((hit) => {
            const traced = hit.chunk_id === tracedId
            return (
              <li key={hit.chunk_id}>
                <button
                  type="button"
                  data-chunk={hit.chunk_id}
                  data-traced={traced}
                  aria-current={hit.chunk_id === selectedId ? 'true' : undefined}
                  onClick={() => onOpen(hit)}
                  onMouseEnter={() => onActive(hit.chunk_id)}
                  onMouseLeave={() => onActive(null)}
                  onFocus={() => onActive(hit.chunk_id)}
                  onBlur={() => onActive(null)}
                  className={cx(
                    'block w-full px-3 py-2 text-left transition-colors duration-100',
                    traced ? 'bg-accent-soft' : 'hover:bg-subtle',
                    hit.chunk_id === selectedId && 'shadow-[inset_2px_0_0_var(--pp-accent)]',
                  )}
                >
                  <span className="flex items-baseline gap-2 text-xs">
                    <span className="w-5 shrink-0 font-semibold text-ink-2 tabular-nums">{hit.rank}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">
                      {hit.document_title} · {hit.page_label}
                    </span>
                    <span className="shrink-0 text-ink-3 tabular-nums">{info.score(hit)}</span>
                  </span>
                  <span className="pp-passage mt-1 line-clamp-2 block pl-7 text-[0.82rem] leading-snug text-ink-2">{hit.text}</span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/** Bars are proportional to the measured milliseconds; nothing is normalised or smoothed. */
function Latency({ data }: { data: LabOut }) {
  const rows: Array<{ label: string; ms: number | null }> = [
    { label: 'Embed query', ms: data.embed_ms },
    { label: 'Keyword', ms: data.keyword.ms },
    { label: 'Semantic', ms: data.semantic.ms },
    { label: 'Fusion', ms: data.fused.ms },
    { label: 'Rerank', ms: data.reranked?.ms ?? null },
  ]
  const scale = Math.max(data.total_ms, ...rows.map((row) => row.ms ?? 0), Number.EPSILON)
  return (
    <section aria-labelledby="lab-latency">
      <SectionHeading id="lab-latency">
        Latency <span className="ml-1 font-normal text-ink-3 tabular-nums">{formatMs(data.total_ms)} total</span>
      </SectionHeading>
      <dl className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 text-[13px]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-ink-2">{row.label}</dt>
            <dd className="contents">
              <span className="h-2 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
                {row.ms === null ? null : (
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max((row.ms / scale) * 100, 0.5)}%` }} />
                )}
              </span>
              <span className="text-right text-ink tabular-nums">{row.ms === null ? 'not run' : formatMs(row.ms)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Facts({ title, rows }: { title: string; rows: Array<[string, ReactNode]> }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
      <dl className="mt-2 space-y-1 text-[13px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="shrink-0 text-ink-3">{label}</dt>
            <dd className="min-w-0 text-right break-words text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Configuration({ data }: { data: LabOut }) {
  const { settings, index, embedding, reranker } = data
  return (
    <section aria-labelledby="lab-config">
      <SectionHeading id="lab-config">Index and model configuration</SectionHeading>
      <p className="mt-1 mb-3 text-[13px] text-ink-2">The exact settings behind this result. The same settings and index version reproduce the same ranking.</p>
      <div className="grid gap-3 md:grid-cols-3">
        <Facts
          title="Effective settings"
          rows={[
            ['Results per stage', settings.top_k],
            ['Candidates per retriever', settings.candidates],
            ['RRF k', settings.rrf_k],
            ['Keyword weight', settings.lexical_weight],
            ['Semantic weight', settings.vector_weight],
            ['Reranked', settings.reranked ? `Yes, top ${settings.rerank_candidates}` : 'No'],
            ['BM25 k1 / b', `${settings.bm25_k1} / ${settings.bm25_b}`],
          ]}
        />
        <Facts
          title="Index"
          rows={[
            ['Passages', formatCount(index.chunks)],
            ['Documents', formatCount(index.documents)],
            ['Vocabulary', `${formatCount(index.vocabulary)} terms`],
            ['Average passage length', `${index.average_chunk_tokens.toFixed(1)} tokens`],
            ['Index version', index.index_version],
            ['In-memory build', index.cached ? `${formatMs(index.build_ms)} (served from cache)` : formatMs(index.build_ms)],
            ['Vector search', index.vector_search],
            ['Tokenizer', index.tokenizer],
          ]}
        />
        <Facts
          title="Models"
          rows={[
            ['Embedding model', embedding.model],
            ['Embedding backend', embedding.backend],
            ['Dimensions', embedding.dimensions ?? 'unknown'],
            ['Embedding version', settings.embedding_version],
            ['Reranker', reranker.enabled === false ? 'Off' : reranker.model],
            ['Reranker backend', reranker.enabled === false ? 'none' : reranker.backend],
          ]}
        />
      </div>
    </section>
  )
}

// ----------------------------------------------------------------------------- evaluation

function Evaluation() {
  const evaluation = useEvaluation()
  return (
    <section aria-labelledby="lab-evaluation" className="mt-10 border-t border-line pt-6">
      <SectionHeading id="lab-evaluation">Evaluation</SectionHeading>
      <p className="mt-1 mb-4 max-w-2xl text-[13px] text-ink-2">
        Retrieval quality measured offline on labelled queries. Recall@k is the share of queries whose relevant passage
        appears in the top k; MRR rewards ranking it near the top.
      </p>
      {evaluation.isPending ? (
        <div role="status" aria-label="Loading evaluation report">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : evaluation.isError ? (
        <Notice
          tone="danger"
          title="The evaluation report could not be loaded."
          action={
            <Button size="sm" onClick={() => void evaluation.refetch()}>
              Try again
            </Button>
          }
        >
          {errorMessage(evaluation.error)}
        </Notice>
      ) : evaluation.data === null ? (
        <EmptyState
          className="rounded-lg border border-line"
          title="No evaluation report on this server"
          description="No measured results are available, so none are shown. When an evaluation run is committed, its numbers appear here together with the command that produced them."
        />
      ) : (
        <EvaluationReport report={evaluation.data} />
      )}
    </section>
  )
}

function numericKeys(runs: EvalDataset['runs']): string[] {
  const keys = new Set(runs.flatMap((run) => Object.keys(run.recall_at_k)))
  return [...keys].sort((a, b) => Number(a) - Number(b))
}

function EvaluationReport({ report }: { report: EvalReport }) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-x-8 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
        <dt className="text-ink-3">Generated</dt>
        <dd className="text-ink">
          <time dateTime={report.generated_at}>{formatDateTime(report.generated_at)}</time>
        </dd>
        <dt className="text-ink-3">Commit</dt>
        <dd className="font-mono text-ink">{report.git_commit ?? 'not recorded'}</dd>
        <dt className="text-ink-3">Hardware</dt>
        <dd className="text-ink">{report.hardware}</dd>
        <dt className="text-ink-3">Command</dt>
        <dd className="min-w-0">
          <code className="block overflow-x-auto rounded bg-subtle px-2 py-1 font-mono text-xs whitespace-pre text-ink">{report.command}</code>
        </dd>
      </dl>
      {report.datasets.map((dataset) => {
        const ks = numericKeys(dataset.runs)
        const hasNdcg = dataset.runs.some((run) => run.ndcg_at_10 !== null && run.ndcg_at_10 !== undefined)
        return (
          <div key={dataset.name} data-testid="eval-dataset">
            <h3 className="text-sm font-semibold text-ink">{dataset.name}</h3>
            <p className="mt-0.5 text-[13px] text-ink-2">{dataset.description}</p>
            <p className="mt-1 text-xs text-ink-3">
              {formatCount(dataset.queries)} queries · {formatCount(dataset.documents)} documents · {formatCount(dataset.chunks)} passages ·{' '}
              {dataset.embedding_version} · reranker {dataset.reranker ?? 'none'} · indexed at{' '}
              {dataset.indexing_chunks_per_second.toFixed(1)} passages/s
            </p>
            <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full border-collapse text-left text-[13px]">
                <caption className="sr-only">{`Retrieval metrics per pipeline for ${dataset.name}`}</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-ink-3">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Pipeline
                    </th>
                    {ks.map((k) => (
                      <th key={k} scope="col" className="px-3 py-2 text-right font-medium">
                        Recall@{k}
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      MRR
                    </th>
                    {hasNdcg ? (
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        nDCG@10
                      </th>
                    ) : null}
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      p50
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      p95
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line tabular-nums">
                  {dataset.runs.map((run) => (
                    <tr key={run.name}>
                      <th scope="row" className="px-3 py-2 font-medium whitespace-nowrap text-ink">
                        {run.name}
                      </th>
                      {ks.map((k) => (
                        <td key={k} className="px-3 py-2 text-right text-ink">
                          {run.recall_at_k[k] === undefined ? '—' : run.recall_at_k[k].toFixed(3)}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right text-ink">{run.mrr.toFixed(3)}</td>
                      {hasNdcg ? (
                        <td className="px-3 py-2 text-right text-ink">
                          {run.ndcg_at_10 === null || run.ndcg_at_10 === undefined ? '—' : run.ndcg_at_10.toFixed(3)}
                        </td>
                      ) : null}
                      <td className="px-3 py-2 text-right text-ink-2">{formatMs(run.latency_ms_p50)}</td>
                      <td className="px-3 py-2 text-right text-ink-2">{formatMs(run.latency_ms_p95)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}
