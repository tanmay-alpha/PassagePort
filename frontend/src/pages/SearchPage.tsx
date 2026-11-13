import { Search, SearchX } from 'lucide-react'
import { type FormEvent, type RefObject, useEffect, useMemo, useRef } from 'react'
import { Link, useLocation } from 'react-router'

import { errorMessage } from '@/api/client'
import { useDocuments, useSearch, useSystem } from '@/api/queries'
import type { CollectionOut, Hit, SearchIn, SearchMode, SearchOut } from '@/api/types'
import { DocumentFilter, parseIdList } from '@/components/documents/DocumentFilter'
import { movePassageFocus, PassageCard } from '@/components/passages/PassageCard'
import { RetrievalLine } from '@/components/passages/PassageText'
import { PreviewLayout } from '@/components/passages/PreviewLayout'
import { Button, buttonClass } from '@/components/ui/Button'
import { EmptyState, Notice, SkeletonList } from '@/components/ui/Feedback'
import { Input, SegmentedControl, Switch } from '@/components/ui/Form'
import { Page, PageHeader, WorkspaceBoundary } from '@/components/ui/Page'
import { cx } from '@/lib/cx'
import { formatMs, plural } from '@/lib/format'
import { useDocumentTitle } from '@/lib/hooks'
import { type PatchParams, useUrlParams } from '@/lib/params'
import { useDraft, useSelectedPassage } from '@/lib/selection'
import { SEARCH_INPUT_ID, sectionPath } from '@/lib/workspace'

export function Component() {
  return <WorkspaceBoundary>{(collection) => <SearchScreen key={collection.id} collection={collection} />}</WorkspaceBoundary>
}

const MODES: Array<{ value: SearchMode; label: string; hint: string }> = [
  { value: 'hybrid', label: 'Hybrid', hint: 'Combine keyword and semantic rankings' },
  { value: 'keyword', label: 'Keyword', hint: 'Exact words, ranked with BM25' },
  { value: 'semantic', label: 'Semantic', hint: 'Meaning, by embedding similarity' },
]
const MODE_NAMES: Record<SearchMode, string> = { hybrid: 'Hybrid', keyword: 'Keyword', semantic: 'Semantic' }
const MAX_TOP_K = 50

function isSearchMode(value: string | null): value is SearchMode {
  return value === 'hybrid' || value === 'keyword' || value === 'semantic'
}

function SearchScreen({ collection }: { collection: CollectionOut }) {
  useDocumentTitle(`Search · ${collection.name}`)
  const [params, patch] = useUrlParams()
  const location = useLocation()
  const system = useSystem()
  const documents = useDocuments(collection.id)
  const queryInput = useRef<HTMLInputElement>(null)
  const results = useRef<HTMLOListElement>(null)

  const q = params.get('q') ?? ''
  const modeParam = params.get('mode')
  const mode: SearchMode = isSearchMode(modeParam) ? modeParam : 'hybrid'
  const rerankParam = params.get('rerank')
  const docsParam = params.get('docs')
  const topK = Number.parseInt(params.get('k') ?? '', 10)
  const hitId = params.get('hit')

  // The box edits a draft; the URL holds the submitted query (and drives the request).
  const [draft, setDraft] = useDraft(q)

  const input = useMemo<SearchIn | null>(() => {
    const query = q.trim()
    if (query === '') return null
    const documentIds = parseIdList(docsParam)
    return {
      query,
      collection_id: collection.id,
      mode,
      rerank: rerankParam === null ? null : rerankParam === '1',
      document_ids: documentIds.length > 0 ? documentIds : null,
      ...(Number.isFinite(topK) ? { top_k: Math.min(Math.max(topK, 1), MAX_TOP_K) } : {}),
    }
  }, [q, docsParam, collection.id, mode, rerankParam, topK])
  const search = useSearch(input)

  const { selected, missing } = useSelectedPassage(hitId, search.data?.results, input === null || !search.isPending)

  const focusRequested =
    typeof location.state === 'object' && location.state !== null && 'focusQuery' in location.state
  useEffect(() => {
    if (focusRequested) queryInput.current?.focus()
  }, [focusRequested, location.key])

  const rerankerAvailable = system.data ? system.data.reranker.enabled !== false : true
  const rerankOn =
    rerankerAvailable &&
    (rerankParam !== null ? rerankParam === '1' : (search.data?.settings.reranked ?? system.data?.search_defaults.rerank ?? false))
  const indexed = useMemo(() => (documents.data ?? []).filter((document) => document.status === 'indexed'), [documents.data])

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    patch({ q: draft.trim(), hit: null, k: null })
  }

  return (
    <PreviewLayout passage={selected} onClose={() => patch({ hit: null })} label="Search">
      <Page>
        <PageHeader eyebrow={collection.name} title="Search" />
        <form role="search" onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden="true" />
              <Input
                ref={queryInput}
                id={SEARCH_INPUT_ID}
                type="search"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    const first = results.current?.querySelector<HTMLButtonElement>('button[data-passage]')
                    if (first) {
                      event.preventDefault()
                      first.focus()
                    }
                  }
                }}
                placeholder={`Search ${collection.name}`}
                aria-label={`Search ${collection.name}`}
                maxLength={system.data?.limits.max_query_chars}
                autoFocus={q === ''}
                autoComplete="off"
                enterKeyHint="search"
                className="h-11 pr-3 pl-10 text-[15px]"
              />
            </div>
            <Button type="submit" variant="primary" className="h-11 px-5" loading={search.isFetching && !search.isPlaceholderData && input !== null}>
              Search
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SegmentedControl
              label="Search mode"
              value={mode}
              onValueChange={(next) => patch({ mode: next === 'hybrid' ? null : next, hit: null, k: null }, { replace: true })}
              options={MODES}
            />
            <label className={cx('flex items-center gap-2 text-[13px]', rerankerAvailable ? 'text-ink' : 'text-ink-3')}>
              <Switch
                checked={rerankOn}
                disabled={!rerankerAvailable}
                onCheckedChange={(checked) => patch({ rerank: checked ? '1' : '0', hit: null }, { replace: true })}
                aria-describedby={rerankerAvailable ? undefined : 'rerank-unavailable'}
              />
              Rerank
            </label>
            {rerankerAvailable ? null : (
              <p id="rerank-unavailable" className="text-[13px] text-ink-3">
                Unavailable: this server runs without a reranker model.
              </p>
            )}
            <div className="sm:ml-auto">
              <DocumentFilter
                documents={indexed}
                selected={parseIdList(docsParam)}
                onChange={(ids) => patch({ docs: ids.join(','), hit: null }, { replace: true })}
              />
            </div>
          </div>
        </form>

        <div className="mt-6">
          {missing ? (
            <Notice
              tone="warning"
              className="mb-4"
              title="The linked passage no longer exists."
              action={
                <Button size="sm" onClick={() => patch({ hit: null }, { replace: true })}>
                  Dismiss
                </Button>
              }
            >
              Its document may have been re-indexed or deleted.
            </Notice>
          ) : null}
          {input === null ? (
            <Idle collection={collection} />
          ) : search.isPending ? (
            <SkeletonList rows={4} label="Searching" />
          ) : search.isError ? (
            <Notice
              tone="danger"
              title="The search could not be completed."
              action={
                <Button size="sm" onClick={() => void search.refetch()}>
                  Try again
                </Button>
              }
            >
              {errorMessage(search.error)}
            </Notice>
          ) : (
            <Results
              data={search.data}
              listRef={results}
              stale={search.isPlaceholderData}
              selectedId={selected?.chunk_id ?? null}
              previewOpen={selected !== null}
              patch={patch}
            />
          )}
        </div>
      </Page>
    </PreviewLayout>
  )
}

function Idle({ collection }: { collection: CollectionOut }) {
  if (collection.indexed_count === 0) {
    return (
      <EmptyState
        icon={<SearchX size={20} aria-hidden="true" />}
        title="Nothing to search yet"
        description={
          collection.processing_count > 0
            ? 'Documents in this workspace are still being indexed.'
            : 'This workspace has no indexed documents. Add some in the library first.'
        }
        action={
          <Link to={sectionPath(collection.id, 'library')} className={buttonClass('primary')}>
            Open library
          </Link>
        }
      />
    )
  }
  return (
    <div className="rounded-lg border border-line px-5 py-4 text-sm text-ink-2">
      <p className="font-medium text-ink">Searching {plural(collection.indexed_count, 'indexed document')}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px]">
        <li>Hybrid finds passages by exact words and by meaning, then merges both rankings.</li>
        <li>Keyword is best for names, codes and exact phrases. Semantic is best for paraphrased questions.</li>
        <li>Open a result to see the passage highlighted on its page.</li>
      </ul>
    </div>
  )
}

interface ResultsProps {
  data: SearchOut
  listRef: RefObject<HTMLOListElement | null>
  /** Previous results shown while a changed search is loading. */
  stale: boolean
  selectedId: string | null
  previewOpen: boolean
  patch: PatchParams
}

function Results({ data, listRef, stale, selectedId, previewOpen, patch }: ResultsProps) {
  const { results, settings, notice, low_confidence: lowConfidence } = data
  const total = data.timings_ms.total
  const canShowMore = results.length >= settings.top_k && settings.top_k < MAX_TOP_K

  return (
    <div className={cx(stale && 'opacity-60')} aria-busy={stale}>
      <p className="mb-3 text-[13px] text-ink-3" role="status">
        {plural(results.length, 'passage')} for “{data.query}” · {MODE_NAMES[settings.mode]}
        {settings.reranked ? `, reranked${settings.reranker ? ` with ${settings.reranker}` : ''}` : ''}
        {total !== undefined ? ` · ${formatMs(total)}` : ''}
      </p>

      {results.length === 0 ? (
        <EmptyState
          className="rounded-lg border border-line"
          icon={<SearchX size={20} aria-hidden="true" />}
          title="No matching passages"
          description={notice ?? 'Try different or fewer words, another search mode, or remove the document filter.'}
        />
      ) : (
        <>
          {lowConfidence ? (
            <Notice tone="warning" className="mb-3" title="Low-confidence results">
              {notice ?? 'Nothing matched this query strongly. The passages below are the closest available.'}
            </Notice>
          ) : notice ? (
            <Notice className="mb-3">{notice}</Notice>
          ) : null}
          <ol ref={listRef} data-passage-list aria-label="Search results" className="space-y-3">
            {results.map((hit: Hit) => (
              <li key={hit.chunk_id}>
                <PassageCard
                  passage={hit}
                  terms={hit.matched_terms}
                  marker={hit.rank}
                  navKey={hit.chunk_id}
                  selected={hit.chunk_id === selectedId}
                  onOpen={() => patch({ hit: hit.chunk_id }, { replace: previewOpen })}
                  onKeyDown={(event) => {
                    const next = movePassageFocus(event)
                    // With the preview open, arrowing through results keeps it in step.
                    if (next?.dataset.passage && previewOpen) patch({ hit: next.dataset.passage }, { replace: true })
                  }}
                >
                  <RetrievalLine hit={hit} mode={settings.mode} />
                </PassageCard>
              </li>
            ))}
          </ol>
          {canShowMore ? (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => patch({ k: String(Math.min(settings.top_k * 2, MAX_TOP_K)) }, { replace: true })}>
                Show more results
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
