import { X } from 'lucide-react'
import { type CSSProperties, type FormEvent, type ReactNode, useMemo } from 'react'
import { Link } from 'react-router'

import { errorMessage } from '@/api/client'
import { useCompare, useDocuments, useSystem } from '@/api/queries'
import type { Alignment, CollectionOut, CompareDocument, CompareIn, CompareOut, Evidence } from '@/api/types'
import { DiffLegend, WordDiff } from '@/components/compare/WordDiff'
import { DocumentFilter, parseIdList } from '@/components/documents/DocumentFilter'
import { AnswerSegments, evidenceElementId } from '@/components/passages/AnswerSegments'
import { PassageCard } from '@/components/passages/PassageCard'
import { PreviewLayout } from '@/components/passages/PreviewLayout'
import { Badge } from '@/components/ui/Badge'
import { Button, buttonClass } from '@/components/ui/Button'
import { Card, EmptyState, Notice, Spinner } from '@/components/ui/Feedback'
import { Input, Switch } from '@/components/ui/Form'
import { Page, PageHeader, SectionHeading, WorkspaceBoundary } from '@/components/ui/Page'
import { formatMs, formatScore, plural } from '@/lib/format'
import { useDocumentTitle } from '@/lib/hooks'
import { useUrlParams } from '@/lib/params'
import { useDraft, useSelectedPassage } from '@/lib/selection'
import { sectionPath } from '@/lib/workspace'

export function Component() {
  return <WorkspaceBoundary>{(collection) => <CompareScreen key={collection.id} collection={collection} />}</WorkspaceBoundary>
}

const MIN_DOCUMENTS = 2
const MAX_DOCUMENTS = 4
/** One column per document from the `lg` breakpoint up; stacked below it. */
const COLUMNS = 'grid gap-3 lg:[grid-template-columns:repeat(var(--columns),minmax(0,1fr))]'

function columnsStyle(count: number): CSSProperties {
  return { '--columns': count } as CSSProperties
}

function CompareScreen({ collection }: { collection: CollectionOut }) {
  useDocumentTitle(`Compare · ${collection.name}`)
  const [params, patch] = useUrlParams()
  const system = useSystem()
  const documents = useDocuments(collection.id)
  const q = params.get('q') ?? ''
  const docsParam = params.get('docs')
  const hitId = params.get('hit')
  const interpret = params.get('interpret') !== '0'
  const [draft, setDraft] = useDraft(q)

  const indexed = useMemo(() => (documents.data ?? []).filter((document) => document.status === 'indexed'), [documents.data])
  const chosenIds = useMemo(() => parseIdList(docsParam).slice(0, MAX_DOCUMENTS), [docsParam])
  const chosen = indexed.filter((document) => chosenIds.includes(document.id))
  const enoughDocuments = chosenIds.length >= MIN_DOCUMENTS

  const input = useMemo<CompareIn | null>(() => {
    const question = q.trim()
    if (question === '' || chosenIds.length < MIN_DOCUMENTS) return null
    return { question, document_ids: chosenIds, interpret }
  }, [q, chosenIds, interpret])
  const compare = useCompare(input)
  const allEvidence = useMemo(() => compare.data?.documents.flatMap((document) => document.evidence), [compare.data])
  const { selected, missing } = useSelectedPassage(hitId, allEvidence, input === null || !compare.isPending)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    patch({ q: draft.trim(), hit: null })
  }

  function open(evidence: Evidence) {
    patch({ hit: evidence.chunk_id }, { replace: selected !== null })
  }

  if (documents.isSuccess && indexed.length < MIN_DOCUMENTS) {
    return (
      <Page>
        <PageHeader eyebrow={collection.name} title="Compare" />
        <EmptyState
          title="Comparing needs at least two indexed documents"
          description={`This workspace has ${plural(indexed.length, 'indexed document')}.`}
          action={
            <Link to={sectionPath(collection.id, 'library')} className={buttonClass('primary')}>
              Open library
            </Link>
          }
        />
      </Page>
    )
  }

  return (
    <PreviewLayout
      passage={selected}
      onClose={() => patch({ hit: null })}
      label="Compare"
      related={allEvidence}
      onSelectRelated={(passage) => patch({ hit: passage.chunk_id }, { replace: true })}
    >
      <Page className="max-w-6xl">
        <PageHeader
          eyebrow={collection.name}
          title="Compare"
          description="Choose two to four documents and a question. PassagePort finds what each one says about it and lines the passages up."
        />
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <DocumentFilter
              documents={indexed}
              selected={chosenIds}
              max={MAX_DOCUMENTS}
              allLabel="Choose documents"
              onChange={(ids) => patch({ docs: ids.join(','), hit: null }, { replace: true })}
            />
            <ul aria-label="Documents to compare" className="flex min-w-0 flex-wrap items-center gap-1.5">
              {chosen.map((document) => (
                <li key={document.id} className="inline-flex h-7 max-w-56 items-center gap-1 rounded-md border border-line bg-surface pr-0.5 pl-2 text-[13px]">
                  <span className="truncate">{document.title}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${document.title} from the comparison`}
                    onClick={() => patch({ docs: chosenIds.filter((id) => id !== document.id).join(','), hit: null }, { replace: true })}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-subtle hover:text-ink"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            {enoughDocuments ? null : (
              <p className="text-[13px] text-ink-3">{`${chosenIds.length} selected. Choose ${MIN_DOCUMENTS} to ${MAX_DOCUMENTS}.`}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="What to compare"
              placeholder="What should be compared? For example: the notice period for termination"
              maxLength={system.data?.limits.max_query_chars}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="primary" loading={compare.isFetching} disabled={!enoughDocuments || draft.trim() === ''}>
              Compare
            </Button>
          </div>
          {system.data?.llm_configured ? (
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <Switch checked={interpret} onCheckedChange={(checked) => patch({ interpret: checked ? null : '0' }, { replace: true })} />
              Add a model interpretation ({system.data.llm_model ?? 'configured model'})
            </label>
          ) : null}
        </form>

        <div className="mt-6">
          {missing ? (
            <Notice tone="warning" className="mb-4" title="The linked passage no longer exists.">
              Its document may have been re-indexed or deleted.
            </Notice>
          ) : null}
          {input === null ? (
            <p className="rounded-lg border border-line px-5 py-4 text-[13px] text-ink-2">
              The comparison is computed from the documents’ own text: shared sentences, sentences unique to each
              document and numbers that differ.
              {system.data?.llm_configured === false ? ' No language model is configured, so no interpretation is added.' : ''}
            </p>
          ) : compare.isPending ? (
            <Card className="p-5 text-ink-2">
              <Spinner label="Finding and aligning passages…" />
            </Card>
          ) : compare.isError ? (
            <Notice
              tone="danger"
              title="The comparison could not be completed."
              action={
                <Button size="sm" onClick={() => void compare.refetch()}>
                  Try again
                </Button>
              }
            >
              {errorMessage(compare.error)}
            </Notice>
          ) : (
            <Comparison
              data={compare.data}
              selectedId={selected?.chunk_id ?? null}
              onOpen={open}
              onCite={(evidence) => {
                open(evidence)
                document.getElementById(evidenceElementId(evidence.ref))?.focus()
              }}
            />
          )}
        </div>
      </Page>
    </PreviewLayout>
  )
}

interface ComparisonProps {
  data: CompareOut
  selectedId: string | null
  onOpen: (evidence: Evidence) => void
  onCite: (evidence: Evidence) => void
}

function Comparison({ data, selectedId, onOpen, onCite }: ComparisonProps) {
  const { documents, alignments, unaligned } = data
  const byRef = useMemo(
    () => new Map(documents.flatMap((document) => document.evidence).map((evidence) => [evidence.ref, evidence])),
    [documents],
  )
  const style = columnsStyle(documents.length)
  const total = data.timings_ms.total

  function card(evidence: Evidence) {
    return (
      <PassageCard
        key={evidence.chunk_id}
        id={evidenceElementId(evidence.ref)}
        passage={evidence}
        terms={evidence.matched_terms}
        marker={evidence.ref}
        selected={evidence.chunk_id === selectedId}
        onOpen={() => onOpen(evidence)}
      />
    )
  }

  return (
    <div className="space-y-8">
      <p className="sr-only" role="status">
        {`Comparison ready: ${plural(alignments.length, 'aligned group')} across ${plural(documents.length, 'document')}.`}
      </p>
      {data.notice ? <Notice>{data.notice}</Notice> : null}

      <section aria-labelledby="compare-documents">
        <SectionHeading id="compare-documents" className="mb-3">
          Documents
          {total !== undefined ? <span className="ml-2 text-xs font-normal text-ink-3">{formatMs(total)}</span> : null}
        </SectionHeading>
        <ul className={COLUMNS} style={style}>
          {documents.map((document) => (
            <li key={document.document_id} className="rounded-lg border border-line bg-surface px-4 py-3" data-testid="compare-document">
              <p className="truncate text-sm font-semibold text-ink" title={document.title}>
                {document.title}
              </p>
              {document.has_evidence ? (
                <p className="mt-0.5 text-[13px] text-ink-2">{plural(document.evidence.length, 'relevant passage')}</p>
              ) : (
                <p className="mt-0.5 text-[13px] text-warning">No relevant passage found in this document.</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {data.interpretation ? (
        <section aria-labelledby="interpretation-heading" className="rounded-lg border border-dashed border-accent/60 bg-accent-soft/50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <SectionHeading id="interpretation-heading">Model interpretation</SectionHeading>
            <Badge tone="accent">Generated</Badge>
          </div>
          <p className="mt-1 text-[13px] text-ink-2">
            Written by {data.llm_model ?? 'the configured language model'}. This is the model’s reading of the passages
            below, not a computed result, and it has not been fact-checked.
          </p>
          <AnswerSegments segments={data.interpretation} extractive={false} byRef={byRef} selectedId={selectedId} onCite={onCite} />
        </section>
      ) : null}

      <section aria-labelledby="aligned-heading">
        <SectionHeading id="aligned-heading">Aligned passages</SectionHeading>
        <p className="mt-1 mb-3 text-[13px] text-ink-2">
          Passages from different documents that discuss the same thing, paired by embedding similarity.
        </p>
        {alignments.length === 0 ? (
          <p className="rounded-lg border border-line px-4 py-3 text-[13px] text-ink-2">
            No passages from different documents were close enough to align.
          </p>
        ) : (
          <div className="space-y-4">
            {alignments.map((alignment, index) => (
              <AlignmentRow key={index} index={index} alignment={alignment} documents={documents} byRef={byRef} style={style} card={card} />
            ))}
          </div>
        )}
      </section>

      {unaligned.length > 0 ? (
        <section aria-labelledby="unaligned-heading">
          <SectionHeading id="unaligned-heading">Passages without a counterpart</SectionHeading>
          <p className="mt-1 mb-3 text-[13px] text-ink-2">Relevant to the question, but no other document has a matching passage.</p>
          <div className={COLUMNS} style={style}>
            {documents.map((document) => {
              const own = unaligned.filter((item) => item.document_id === document.document_id)
              return (
                <div key={document.document_id} className="min-w-0 space-y-3">
                  <p className="truncate text-xs font-medium text-ink-3">{document.title}</p>
                  {own.length === 0 ? (
                    <p className="text-[13px] text-ink-3">None</p>
                  ) : (
                    own.map((item) => {
                      const evidence = byRef.get(item.ref)
                      return evidence ? card(evidence) : null
                    })
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ) : null}
    </div>
  )
}

interface AlignmentRowProps {
  index: number
  alignment: Alignment
  documents: CompareDocument[]
  byRef: Map<number, Evidence>
  style: CSSProperties
  card: (evidence: Evidence) => ReactNode
}

function AlignmentRow({ index, alignment, documents, byRef, style, card }: AlignmentRowProps) {
  const headingId = `alignment-${index + 1}`
  const aligned = documents.filter((document) => alignment.passages.some((passage) => passage.document_id === document.document_id))
  const uniqueCount = Object.values(alignment.unique_sentences).reduce((sum, sentences) => sum + sentences.length, 0)
  const nothingComputed =
    !alignment.identical && alignment.shared_sentences.length === 0 && uniqueCount === 0 && alignment.numeric_differences.length === 0
  // Every other aligned passage is diffed against the first one, in document order.
  const diffed = aligned.flatMap((document) => {
    const passage = alignment.passages.find((item) => item.document_id === document.document_id)
    const evidence = passage ? byRef.get(passage.ref) : undefined
    return evidence ? [{ title: document.title, evidence }] : []
  })
  const [base, ...others] = diffed

  return (
    <article aria-labelledby={headingId} className="overflow-hidden rounded-lg border border-line" data-testid="alignment">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <h3 id={headingId} className="text-[13px] font-semibold text-ink">
          Alignment {index + 1}
        </h3>
        <Badge>{`Similarity ${formatScore(alignment.similarity, 2)}`}</Badge>
        {alignment.identical ? <Badge tone="success">Identical text</Badge> : null}
      </header>

      <div className={`${COLUMNS} p-3`} style={style}>
        {documents.map((document) => {
          const passage = alignment.passages.find((item) => item.document_id === document.document_id)
          const evidence = passage ? byRef.get(passage.ref) : undefined
          if (evidence) return card(evidence)
          return (
            <div
              key={document.document_id}
              className="flex min-h-16 flex-col justify-center rounded-lg border border-dashed border-line-strong px-4 py-3 text-[13px] text-ink-3"
            >
              <span className="truncate font-medium text-ink-2 lg:hidden">{document.title}</span>
              {document.has_evidence ? 'No counterpart in this document.' : 'No relevant passage found in this document.'}
            </div>
          )
        })}
      </div>

      <div className="border-t border-line bg-subtle px-4 py-3">
        <h4 className="text-xs font-semibold tracking-wide text-ink-2 uppercase">Computed from text</h4>
        <p className="mt-0.5 text-xs text-ink-3">
          Found by comparing the passages’ sentences and numbers directly. No language model is involved.
        </p>
        {alignment.identical ? <p className="mt-2 text-[13px] text-ink">The aligned passages are word for word the same.</p> : null}
        {nothingComputed ? (
          <p className="mt-2 text-[13px] text-ink-2">No shared sentences, unique sentences or differing numbers were detected.</p>
        ) : null}

        {base && others.length > 0 && !alignment.identical ? (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h5 className="text-[13px] font-medium text-ink">Word-level changes</h5>
              <DiffLegend />
            </div>
            {others.map((other) => (
              <WordDiff
                key={other.evidence.chunk_id}
                fromTitle={base.title}
                fromText={base.evidence.text}
                toTitle={other.title}
                toText={other.evidence.text}
              />
            ))}
          </div>
        ) : null}

        {alignment.shared_sentences.length > 0 ? (
          <div className="mt-3">
            <h5 className="text-[13px] font-medium text-ink">In every aligned passage</h5>
            <ul className="pp-passage mt-1 list-disc space-y-1 pl-5 text-[0.9rem] text-ink">
              {alignment.shared_sentences.map((sentence, sentenceIndex) => (
                <li key={sentenceIndex}>{sentence}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {uniqueCount > 0 ? (
          <div className={`${COLUMNS} mt-3`} style={columnsStyle(aligned.length)}>
            {aligned.map((document) => {
              const sentences = alignment.unique_sentences[document.document_id] ?? []
              return (
                <div key={document.document_id} className="min-w-0">
                  <h5 className="truncate text-[13px] font-medium text-ink">Only in {document.title}</h5>
                  {sentences.length === 0 ? (
                    <p className="mt-1 text-[13px] text-ink-3">Nothing unique.</p>
                  ) : (
                    <ul className="pp-passage mt-1 list-disc space-y-1 pl-5 text-[0.9rem] text-ink">
                      {sentences.map((sentence, sentenceIndex) => (
                        <li key={sentenceIndex}>{sentence}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}

        {alignment.numeric_differences.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <caption className="mb-1 text-left text-[13px] font-medium text-ink">Numbers that differ</caption>
              <thead>
                <tr className="border-b border-line-strong text-xs text-ink-3">
                  <th scope="col" className="py-1.5 pr-4 font-medium">
                    Context
                  </th>
                  {aligned.map((document) => (
                    <th key={document.document_id} scope="col" className="max-w-40 truncate py-1.5 pr-4 font-medium" title={document.title}>
                      {document.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {alignment.numeric_differences.map((difference, differenceIndex) => (
                  <tr key={differenceIndex}>
                    <th scope="row" className="py-1.5 pr-4 font-normal text-ink-2">
                      {difference.context}
                    </th>
                    {aligned.map((document) => (
                      <td key={document.document_id} className="py-1.5 pr-4 text-ink tabular-nums">
                        {difference.values[document.document_id] === undefined ? (
                          '—'
                        ) : (
                          <span className="pp-diff-number inline-block rounded bg-mark px-1.5 font-semibold">
                            {difference.values[document.document_id]}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </article>
  )
}
