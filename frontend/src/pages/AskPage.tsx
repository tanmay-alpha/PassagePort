import { type FormEvent, useMemo } from 'react'
import { Link } from 'react-router'

import { errorMessage } from '@/api/client'
import { useAsk, useDocuments, useSystem } from '@/api/queries'
import type { AskIn, AskMode, AskOut, CollectionOut, Evidence } from '@/api/types'
import { DocumentFilter, parseIdList } from '@/components/documents/DocumentFilter'
import { AnswerSegments, evidenceElementId } from '@/components/passages/AnswerSegments'
import { movePassageFocus, PassageCard } from '@/components/passages/PassageCard'
import { RetrievalLine } from '@/components/passages/PassageText'
import { PreviewLayout } from '@/components/passages/PreviewLayout'
import { Badge } from '@/components/ui/Badge'
import { Button, buttonClass } from '@/components/ui/Button'
import { Card, EmptyState, Notice, Spinner } from '@/components/ui/Feedback'
import { Textarea } from '@/components/ui/Form'
import { Page, PageHeader, SectionHeading, WorkspaceBoundary } from '@/components/ui/Page'
import { formatMs, plural } from '@/lib/format'
import { useDocumentTitle } from '@/lib/hooks'
import { useUrlParams } from '@/lib/params'
import { useDraft, useSelectedPassage } from '@/lib/selection'
import { sectionPath } from '@/lib/workspace'

export function Component() {
  return <WorkspaceBoundary>{(collection) => <AskScreen key={collection.id} collection={collection} />}</WorkspaceBoundary>
}

function AskScreen({ collection }: { collection: CollectionOut }) {
  useDocumentTitle(`Ask · ${collection.name}`)
  const [params, patch] = useUrlParams()
  const system = useSystem()
  const documents = useDocuments(collection.id)
  const q = params.get('q') ?? ''
  const docsParam = params.get('docs')
  const hitId = params.get('hit')
  const [draft, setDraft] = useDraft(q)

  const input = useMemo<AskIn | null>(() => {
    const question = q.trim()
    if (question === '') return null
    const documentIds = parseIdList(docsParam)
    return { question, collection_id: collection.id, document_ids: documentIds.length > 0 ? documentIds : null }
  }, [q, docsParam, collection.id])
  const ask = useAsk(input)
  const { selected, missing } = useSelectedPassage(hitId, ask.data?.evidence, input === null || !ask.isPending)
  const indexed = useMemo(() => (documents.data ?? []).filter((document) => document.status === 'indexed'), [documents.data])

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    patch({ q: draft.trim(), hit: null })
  }

  function cite(evidence: Evidence) {
    patch({ hit: evidence.chunk_id }, { replace: selected !== null })
    document.getElementById(evidenceElementId(evidence.ref))?.focus()
  }

  return (
    <PreviewLayout passage={selected} onClose={() => patch({ hit: null })} label="Ask">
      <Page className="max-w-3xl">
        <PageHeader
          eyebrow={collection.name}
          title="Ask"
          description="Ask a question the documents can answer. The answer cites the passages it relies on, and every citation opens its source."
        />
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            rows={2}
            aria-label="Your question"
            placeholder="What do you want to know?"
            maxLength={system.data?.limits.max_query_chars}
            autoFocus={q === ''}
            className="text-[15px]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <DocumentFilter
              documents={indexed}
              selected={parseIdList(docsParam)}
              onChange={(ids) => patch({ docs: ids.join(','), hit: null }, { replace: true })}
            />
            <p className="hidden text-xs text-ink-3 sm:block">Enter to ask · Shift+Enter for a new line</p>
            <Button type="submit" variant="primary" className="ml-auto" loading={ask.isFetching} disabled={draft.trim() === ''}>
              Ask
            </Button>
          </div>
        </form>

        <div className="mt-6">
          {missing ? (
            <Notice tone="warning" className="mb-4" title="The linked passage no longer exists.">
              Its document may have been re-indexed or deleted.
            </Notice>
          ) : null}
          {input === null ? (
            <Idle collection={collection} llmConfigured={system.data?.llm_configured} />
          ) : ask.isPending ? (
            <Card className="p-5 text-ink-2">
              <Spinner label={system.data?.llm_configured ? 'Finding evidence and writing an answer…' : 'Finding evidence…'} />
            </Card>
          ) : ask.isError ? (
            <Notice
              tone="danger"
              title="The question could not be answered."
              action={
                <Button size="sm" onClick={() => void ask.refetch()}>
                  Try again
                </Button>
              }
            >
              {errorMessage(ask.error)}
            </Notice>
          ) : (
            <Answer data={ask.data} selectedId={selected?.chunk_id ?? null} onCite={cite} onOpen={(evidence) => patch({ hit: evidence.chunk_id }, { replace: selected !== null })} />
          )}
        </div>
      </Page>
    </PreviewLayout>
  )
}

function Idle({ collection, llmConfigured }: { collection: CollectionOut; llmConfigured: boolean | undefined }) {
  if (collection.indexed_count === 0) {
    return (
      <EmptyState
        title="Nothing to ask about yet"
        description="This workspace has no indexed documents. Add some in the library first."
        action={
          <Link to={sectionPath(collection.id, 'library')} className={buttonClass('primary')}>
            Open library
          </Link>
        }
      />
    )
  }
  return (
    <div className="rounded-lg border border-line px-5 py-4 text-[13px] text-ink-2">
      <ul className="list-disc space-y-1 pl-5">
        <li>Specific questions work best: a definition, a figure, a deadline, who is responsible for something.</li>
        <li>If the documents do not contain enough evidence, PassagePort says so instead of guessing.</li>
        {llmConfigured === false ? (
          <li>
            No language model is configured, so answers are verbatim excerpts with citations.{' '}
            <Link to="/settings#answers" className="font-medium text-accent hover:underline">
              How to enable generated answers
            </Link>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

const MODE_LABELS: Record<AskMode, string> = {
  generated: 'Generated answer',
  extractive: 'Excerpts from your documents',
  insufficient: 'Not enough evidence',
}

interface AnswerProps {
  data: AskOut
  selectedId: string | null
  onCite: (evidence: Evidence) => void
  onOpen: (evidence: Evidence) => void
}

function Answer({ data, selectedId, onCite, onOpen }: AnswerProps) {
  const byRef = useMemo(() => new Map(data.evidence.map((evidence) => [evidence.ref, evidence])), [data.evidence])
  const total = data.timings_ms.total
  const unsupported = data.segments.some((segment) => !segment.supported)

  return (
    <div className="space-y-6">
      <p className="sr-only" role="status">
        {`${MODE_LABELS[data.mode]}. ${plural(data.evidence.length, 'passage')} retrieved.`}
      </p>
      <Card className="p-5" role="region" aria-labelledby="answer-heading">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="answer-heading" className="sr-only">
            Answer
          </h2>
          <Badge tone={data.mode === 'generated' ? 'accent' : data.mode === 'insufficient' ? 'warning' : 'neutral'}>
            {MODE_LABELS[data.mode]}
          </Badge>
          {total !== undefined ? <span className="text-xs text-ink-3">{formatMs(total)}</span> : null}
        </div>
        <p className="mt-2 text-[13px] text-ink-2">
          {data.mode === 'generated' ? (
            <>
              Written by {data.llm_model ?? 'the configured language model'} from the passages below. It has not been
              independently fact-checked; follow the citations to verify.
            </>
          ) : data.mode === 'extractive' ? (
            <>
              No language model is configured, so these are verbatim sentences from the most relevant passages, not a
              written answer.{' '}
              <Link to="/settings#answers" className="font-medium text-accent hover:underline">
                How to enable generated answers
              </Link>
            </>
          ) : (
            (data.notice ?? 'The retrieved passages are too weak to support an answer, so none was written.')
          )}
        </p>

        {data.segments.length > 0 ? (
          <AnswerSegments segments={data.segments} extractive={data.mode === 'extractive'} byRef={byRef} selectedId={selectedId} onCite={onCite} />
        ) : null}
        {unsupported ? (
          <p className="mt-3 text-[13px] text-warning">
            Sentences marked “No citation” are not backed by any retrieved passage. Treat them as unverified.
          </p>
        ) : null}
        {data.notice && data.mode !== 'insufficient' ? <Notice className="mt-4">{data.notice}</Notice> : null}

        {data.checks.length > 0 ? (
          <details className="mt-4 border-t border-line pt-3 text-[13px] text-ink-2">
            <summary className="rounded-sm font-medium text-ink">What was checked</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {data.checks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      <section aria-labelledby="evidence-heading">
        <SectionHeading id="evidence-heading" className="mb-3">
          {data.mode === 'insufficient' ? 'What was retrieved' : 'Evidence'}
        </SectionHeading>
        {data.evidence.length === 0 ? (
          <p className="text-[13px] text-ink-2">No passages were retrieved for this question.</p>
        ) : (
          <ol data-passage-list className="space-y-3">
            {data.evidence.map((evidence) => (
              <li key={evidence.chunk_id}>
                <PassageCard
                  id={evidenceElementId(evidence.ref)}
                  passage={evidence}
                  terms={evidence.matched_terms}
                  marker={evidence.ref}
                  navKey={evidence.chunk_id}
                  selected={evidence.chunk_id === selectedId}
                  onOpen={() => onOpen(evidence)}
                  onKeyDown={movePassageFocus}
                >
                  <RetrievalLine hit={evidence} mode="any" />
                </PassageCard>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
