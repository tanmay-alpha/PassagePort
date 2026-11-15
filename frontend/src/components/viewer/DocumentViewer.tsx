import { ChevronLeft, ChevronRight, Download, FileWarning, Maximize2, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { documentFileUrl, errorMessage, isApiError } from '@/api/client'
import { isIndexing, useDocument, useOutline, usePage } from '@/api/queries'
import type { DocumentOut, OutlineItem, Passage } from '@/api/types'
import { StatusBadge } from '@/components/ui/Badge'
import { Button, buttonClass, IconButton } from '@/components/ui/Button'
import { EmptyState, Notice, Skeleton, Spinner } from '@/components/ui/Feedback'
import { Input, NativeSelect } from '@/components/ui/Form'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { Tooltip } from '@/components/ui/Tooltip'
import { cx } from '@/lib/cx'
import { formatBytes, kindLabel, locatorNoun } from '@/lib/format'
import { splitByCodePoints, type TextRange } from '@/lib/text'
import { viewerPath } from '@/lib/workspace'

import { HitStrip } from './HitStrip'

// pdf.js is large; it is only downloaded when a PDF's Original tab is actually shown.
const PdfPane = lazy(() => import('./PdfPane'))

type ViewerTab = 'original' | 'text'

export interface DocumentViewerProps {
  documentId: string
  /** 1-based page (PDF) or section (other formats). */
  page: number
  onPageChange: (page: number) => void
  /** The cited passage to highlight when its page is shown. */
  highlight: Passage | null
  /** Other passages of the same result list, mapped onto this document's pages. */
  related?: readonly Passage[]
  onSelectRelated?: (passage: Passage) => void
  /** Present when embedded as a preview: adds "open full view" and close actions. */
  onClose?: () => void
}

export function DocumentViewer(props: DocumentViewerProps) {
  const document = useDocument(props.documentId)

  if (document.isPending) {
    return (
      <div className="space-y-3 p-4" role="status" aria-label="Loading document">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (document.isError) {
    const missing = isApiError(document.error, 'not_found')
    return (
      <EmptyState
        icon={<FileWarning size={20} aria-hidden="true" />}
        title={missing ? 'Document not found' : 'This document could not be loaded'}
        description={missing ? 'It may have been deleted, or the link is incorrect.' : errorMessage(document.error)}
        action={
          <>
            {missing ? null : <Button onClick={() => void document.refetch()}>Try again</Button>}
            {props.onClose ? <Button onClick={props.onClose}>Close preview</Button> : null}
          </>
        }
      />
    )
  }
  // Remount per document so tab choice and PDF state never leak between documents.
  return <LoadedViewer key={document.data.id} {...props} document={document.data} />
}

function LoadedViewer({
  document,
  page,
  onPageChange,
  highlight,
  related,
  onSelectRelated,
  onClose,
}: DocumentViewerProps & { document: DocumentOut }) {
  const embedded = onClose !== undefined
  const isPdf = document.kind === 'pdf'
  const [tab, setTab] = useState<ViewerTab>(isPdf ? 'original' : 'text')
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null)
  const hasText = document.page_count > 0
  const pageCount = document.page_count || pdfPageCount || 0
  const currentPage = Math.min(Math.max(page, 1), Math.max(pageCount, 1))
  const outline = useOutline(document.id, hasText)
  const outlineItems = outline.data?.items ?? []
  const pageLabel = outlineItems.find((item) => item.page_number === currentPage)?.page_label

  const cited = highlight && highlight.document_id === document.id ? highlight : null
  const citedHere = cited && cited.page_number === currentPage ? cited : null
  const Heading = embedded ? 'h2' : 'h1'
  const noun = locatorNoun(document.locator_kind)

  const textPane = hasText ? (
    <TextPane documentId={document.id} page={currentPage} highlight={citedHere} />
  ) : (
    <NoTextState document={document} />
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <header className="shrink-0 border-b border-line px-4 pt-3 pb-2">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1 pr-2">
            <Heading className="truncate text-base font-semibold text-ink" title={document.title}>
              {document.title}
            </Heading>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-3">
              <span>{kindLabel(document.kind)}</span>
              {pageCount > 0 ? <span>{`${pageCount} ${locatorNoun(document.locator_kind, pageCount)}`}</span> : null}
              <span>{formatBytes(document.size_bytes)}</span>
              {document.status === 'indexed' && !document.stale ? null : <StatusBadge document={document} />}
            </p>
          </div>
          <Tooltip content="Download original">
            <a
              href={documentFileUrl(document.id)}
              download={document.filename}
              aria-label={`Download original file ${document.filename}`}
              className={buttonClass('ghost', 'md', 'size-9 px-0')}
            >
              <Download size={16} aria-hidden="true" />
            </a>
          </Tooltip>
          {embedded ? (
            <>
              <Tooltip content="Open full view">
                <Link
                  to={viewerPath({ documentId: document.id, page: currentPage, chunkId: citedHere?.chunk_id })}
                  aria-label="Open full view"
                  className={buttonClass('ghost', 'md', 'size-9 px-0')}
                >
                  <Maximize2 size={16} aria-hidden="true" />
                </Link>
              </Tooltip>
              <IconButton label="Close preview" icon={<X size={16} aria-hidden="true" />} onClick={onClose} />
            </>
          ) : null}
        </div>
        {pageCount > 0 ? (
          <PageNav
            page={currentPage}
            pageCount={pageCount}
            noun={noun}
            outline={outlineItems}
            sections={document.locator_kind === 'section'}
            onPageChange={onPageChange}
          />
        ) : null}
        {cited && !citedHere ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
            The cited passage is in {cited.page_label}.
            <Button size="sm" onClick={() => onPageChange(cited.page_number)}>
              Go to passage
            </Button>
          </p>
        ) : null}
        {related && onSelectRelated && pageCount > 0 ? (
          <HitStrip
            documentId={document.id}
            pageCount={pageCount}
            related={related}
            currentId={cited?.chunk_id ?? null}
            onSelect={onSelectRelated}
          />
        ) : null}
      </header>

      {isPdf ? (
        <Tabs value={tab} onValueChange={(value) => setTab(value as ViewerTab)} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 px-3" aria-label="Document view">
            <TabsTrigger value="original">Original</TabsTrigger>
            <TabsTrigger value="text">Text</TabsTrigger>
          </TabsList>
          <TabsContent value="original" className="min-h-0 flex-1">
            <Suspense
              fallback={
                <div className="p-4 text-ink-2">
                  <Spinner label="Loading PDF viewer…" />
                </div>
              }
            >
              <PdfPane
                documentId={document.id}
                page={currentPage}
                highlightText={citedHere?.text ?? null}
                onShowText={() => setTab('text')}
                onPageCount={setPdfPageCount}
              />
            </Suspense>
          </TabsContent>
          <TabsContent value="text" className="min-h-0 flex-1 overflow-y-auto">
            {textPane}
          </TabsContent>
        </Tabs>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {pageLabel ? <p className="sr-only" aria-live="polite">{`Showing ${pageLabel}`}</p> : null}
          {textPane}
        </div>
      )}
    </div>
  )
}

function NoTextState({ document }: { document: DocumentOut }) {
  if (document.status === 'failed') {
    return (
      <EmptyState
        icon={<FileWarning size={20} aria-hidden="true" />}
        title="This document could not be indexed"
        description={document.error ?? 'No reason was recorded. Retry indexing from the library.'}
      />
    )
  }
  if (isIndexing(document)) {
    return (
      <EmptyState
        title="Indexing in progress"
        description={<Spinner label="The extracted text appears here as soon as indexing finishes." />}
      />
    )
  }
  return <EmptyState title="No text was extracted from this document" description="It may contain only images." />
}

interface PageNavProps {
  page: number
  pageCount: number
  noun: string
  outline: OutlineItem[]
  sections: boolean
  onPageChange: (page: number) => void
}

function PageNav({ page, pageCount, noun, outline, sections, onPageChange }: PageNavProps) {
  function commit(raw: string) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) {
      const next = Math.min(Math.max(parsed, 1), pageCount)
      if (next !== page) onPageChange(next)
    }
  }
  const capitalNoun = noun.charAt(0).toUpperCase() + noun.slice(1)

  return (
    <nav aria-label={`${capitalNoun} navigation`} className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-2">
      <IconButton
        size="sm"
        label={`Previous ${noun}`}
        icon={<ChevronLeft size={16} aria-hidden="true" />}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      />
      <label className="flex shrink-0 items-center gap-1.5 text-[13px] whitespace-nowrap text-ink-2">
        {capitalNoun}
        {/* Uncontrolled and re-keyed per page: typing never fights the committed value. */}
        <Input
          key={page}
          type="text"
          inputMode="numeric"
          defaultValue={page}
          className="h-8 shrink-0 px-2 text-center tabular-nums"
          style={{ width: '3.5rem' }}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value)
          }}
        />
        <span className="whitespace-nowrap tabular-nums">of {pageCount}</span>
      </label>
      <IconButton
        size="sm"
        label={`Next ${noun}`}
        icon={<ChevronRight size={16} aria-hidden="true" />}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      />
      {outline.length > 1 ? (
        <NativeSelect
          aria-label={sections ? 'Jump to section' : 'Jump to page'}
          className="ml-1 max-w-56 min-w-0"
          value={page}
          onChange={(event) => onPageChange(Number(event.target.value))}
        >
          {outline.map((item) => (
            <option key={item.page_number} value={item.page_number}>
              {sections ? `${item.page_number}. ${item.page_label}` : item.page_label}
            </option>
          ))}
        </NativeSelect>
      ) : null}
    </nav>
  )
}

type Located = { state: 'none' } | { state: 'found'; range: TextRange } | { state: 'missing' }

/**
 * `char_start`/`char_end` are authoritative. If they no longer reproduce the passage (the
 * document was re-indexed after the citation was made) fall back to a verbatim search, and
 * otherwise report that nothing could be highlighted.
 */
function locatePassage(text: string, highlight: Passage | null): Located {
  if (!highlight) return { state: 'none' }
  const range = splitByCodePoints(text, highlight.char_start, highlight.char_end)
  if (range && range.match === highlight.text) return { state: 'found', range }
  const index = highlight.text.length > 0 ? text.indexOf(highlight.text) : -1
  if (index < 0) return { state: 'missing' }
  const end = index + highlight.text.length
  return { state: 'found', range: { before: text.slice(0, index), match: text.slice(index, end), after: text.slice(end) } }
}

function TextPane({ documentId, page, highlight }: { documentId: string; page: number; highlight: Passage | null }) {
  const query = usePage(documentId, page, true)
  const mark = useRef<HTMLElement>(null)
  const data = query.data
  // While the next page loads the previous one stays visible; highlight only matching data.
  const current = data !== undefined && data.page_number === page
  const located: Located = current ? locatePassage(data.text, highlight) : { state: 'none' }
  const chunkId = highlight?.chunk_id

  useEffect(() => {
    if (located.state === 'found') mark.current?.scrollIntoView({ block: 'center' })
  }, [located.state, chunkId, page])

  if (query.isPending) {
    return (
      <div className="mx-auto max-w-[72ch] space-y-3 p-6" role="status" aria-label="Loading text">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    )
  }
  if (query.isError || !data) {
    return (
      <div className="p-4">
        <Notice
          tone="danger"
          title="The text of this page could not be loaded."
          action={
            <Button size="sm" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        >
          {errorMessage(query.error)}
        </Notice>
      </div>
    )
  }

  return (
    <div className={cx('mx-auto max-w-[72ch] px-6 py-5', !current && 'opacity-60')} aria-busy={!current}>
      <p className="mb-3 text-xs font-medium tracking-wide text-ink-3 uppercase">{data.page_label}</p>
      {located.state === 'missing' ? (
        <Notice tone="warning" className="mb-4" title="The cited passage could not be found on this page.">
          The document may have been re-indexed since this citation was created. Nothing is highlighted.
        </Notice>
      ) : null}
      {data.text.trim().length === 0 ? (
        <p className="text-ink-2">No text was extracted here. The original may be a scanned image.</p>
      ) : (
        <div className="pp-passage whitespace-pre-wrap text-ink" data-testid="page-text">
          {located.state === 'found' ? (
            <>
              {located.range.before}
              <mark ref={mark} className="pp-cited" data-testid="cited-passage">
                {located.range.match}
              </mark>
              {located.range.after}
            </>
          ) : (
            data.text
          )}
        </div>
      )}
    </div>
  )
}
