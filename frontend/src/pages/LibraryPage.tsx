import { useQueryClient } from '@tanstack/react-query'
import {
  CircleAlert,
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Files,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { type DragEvent, type FormEvent, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'

import { documentFileUrl, errorMessage } from '@/api/client'
import {
  invalidateLibrary,
  isIndexing,
  useDeleteDocument,
  useDocuments,
  useReindexDocument,
  useRenameDocument,
  useSystem,
} from '@/api/queries'
import type { CollectionOut, DocumentOut, LimitsOut } from '@/api/types'
import { DOCUMENT_STATE_LABELS, type DocumentState, documentState, StatusBadge } from '@/components/ui/Badge'
import { Button, buttonClass, IconButton } from '@/components/ui/Button'
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog'
import { EmptyState, Notice, ProgressBar, SkeletonList, Spinner } from '@/components/ui/Feedback'
import { Field, Input, Select, type SelectOption } from '@/components/ui/Form'
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { Page, PageHeader, WorkspaceBoundary } from '@/components/ui/Page'
import { useToast } from '@/components/ui/Toast'
import { cx } from '@/lib/cx'
import { formatBytes, formatDateTime, formatRelative, kindLabel, locatorNoun, plural } from '@/lib/format'
import { useDocumentTitle, useMediaQuery } from '@/lib/hooks'
import {
  cancelUpload,
  clearFinishedUploads,
  enqueueUploads,
  isActiveUpload,
  type UploadItem,
  useUploads,
} from '@/lib/uploads'
import { sectionPath, viewerPath } from '@/lib/workspace'

export function Component() {
  return <WorkspaceBoundary>{(collection) => <Library key={collection.id} collection={collection} />}</WorkspaceBoundary>
}

type StatusFilter = 'all' | DocumentState

const STATUS_OPTIONS: Array<SelectOption<StatusFilter>> = [
  { value: 'all', label: 'All statuses' },
  ...(['indexed', 'processing', 'uploaded', 'failed', 'stale'] as const).map((state) => ({
    value: state,
    label: DOCUMENT_STATE_LABELS[state],
  })),
]

function Library({ collection }: { collection: CollectionOut }) {
  useDocumentTitle(collection.name)
  const documents = useDocuments(collection.id)
  const system = useSystem()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [renaming, setRenaming] = useState<DocumentOut | null>(null)
  const [deleting, setDeleting] = useState<DocumentOut | null>(null)

  const indexing = documents.data?.some(isIndexing) ?? false

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase()
    return (documents.data ?? []).filter(
      (document) =>
        (status === 'all' || documentState(document) === status) &&
        (needle === '' || document.title.toLowerCase().includes(needle) || document.filename.toLowerCase().includes(needle)),
    )
  }, [documents.data, text, status])

  const total = documents.data?.length ?? 0

  return (
    <Page>
      <PageHeader
        eyebrow="Library"
        title={collection.name}
        description={collection.description || undefined}
        actions={
          collection.indexed_count > 0 ? (
            <Link to={sectionPath(collection.id, 'search')} className={buttonClass('secondary')}>
              <Search size={16} aria-hidden="true" />
              Search
            </Link>
          ) : null
        }
      />

      {system.data ? (
        <UploadArea collectionId={collection.id} limits={system.data.limits} prominent={documents.isSuccess && total === 0} />
      ) : system.isError ? (
        <Notice tone="danger" title="Uploading is unavailable because the server limits could not be loaded.">
          {errorMessage(system.error)}
        </Notice>
      ) : (
        <div className="h-24 animate-pulse rounded-lg border border-dashed border-line-strong motion-reduce:animate-none" aria-hidden="true" />
      )}

      <section aria-labelledby="documents-heading" className="mt-8">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 id="documents-heading" className="text-sm font-semibold text-ink">
            Documents
          </h2>
          <p className="text-[13px] text-ink-3" aria-live="polite">
            {documents.isSuccess
              ? filtered.length === total
                ? plural(total, 'document')
                : `${filtered.length} of ${plural(total, 'document')}`
              : null}
            {indexing ? <Spinner size={12} className="ml-2 align-middle" label="Indexing…" /> : null}
          </p>
          {total > 0 ? (
            <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Input
                type="search"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Filter by title or file name"
                aria-label="Filter documents by title or file name"
                className="min-w-0 flex-1 sm:w-64 sm:flex-none"
              />
              <Select value={status} onValueChange={setStatus} options={STATUS_OPTIONS} aria-label="Filter by status" className="w-40" />
            </div>
          ) : null}
        </div>

        {documents.isPending ? (
          <SkeletonList rows={4} label="Loading documents" />
        ) : documents.isError ? (
          <Notice
            tone="danger"
            title="The documents could not be loaded."
            action={
              <Button size="sm" onClick={() => void documents.refetch()}>
                Try again
              </Button>
            }
          >
            {errorMessage(documents.error)}
          </Notice>
        ) : total === 0 ? (
          <EmptyState
            className="rounded-lg border border-line"
            icon={<Files size={20} aria-hidden="true" />}
            title="No documents yet"
            description="Add a file above. Once it is indexed you can search it, ask questions about it and compare it with other documents."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            className="rounded-lg border border-line"
            title="No documents match these filters"
            action={
              <Button
                onClick={() => {
                  setText('')
                  setStatus('all')
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <DocumentList documents={filtered} onRename={setRenaming} onDelete={setDeleting} />
        )}
      </section>

      {renaming ? <RenameDialog key={renaming.id} document={renaming} onClose={() => setRenaming(null)} /> : null}
      <DeleteDocumentDialog document={deleting} onClose={() => setDeleting(null)} />
    </Page>
  )
}

// ----------------------------------------------------------------------------- upload

function UploadArea({ collectionId, limits, prominent }: { collectionId: string; limits: LimitsOut; prominent: boolean }) {
  const queryClient = useQueryClient()
  const uploads = useUploads(collectionId)
  const input = useRef<HTMLInputElement>(null)
  const [dragDepth, setDragDepth] = useState(0)
  const extensions = limits.allowed_extensions.map((extension) => `.${extension.replace(/^\./, '').toLowerCase()}`)

  function add(files: FileList | null) {
    if (!files || files.length === 0) return
    enqueueUploads(collectionId, Array.from(files), limits, () => invalidateLibrary(queryClient, collectionId))
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragDepth(0)
    add(event.dataTransfer.files)
  }

  const finished = uploads.filter((item) => !isActiveUpload(item))
  const problems = finished.filter((item) => item.status === 'failed' || item.status === 'rejected').length

  return (
    <section aria-label="Add documents">
      <div
        onDragEnter={(event) => {
          event.preventDefault()
          setDragDepth((depth) => depth + 1)
        }}
        onDragLeave={() => setDragDepth((depth) => Math.max(depth - 1, 0))}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        className={cx(
          'flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 text-center transition-colors duration-100 sm:flex-row sm:text-left',
          prominent ? 'py-8 sm:px-6' : 'py-4',
          dragDepth > 0 ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface',
        )}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-subtle text-ink-2">
          <FileUp size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{dragDepth > 0 ? 'Drop to upload' : 'Drop files here to add them'}</p>
          <p className="mt-0.5 text-[13px] text-ink-3">
            {extensions.join(', ')} · up to {formatBytes(limits.max_upload_bytes)} per file
          </p>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept={extensions.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="file-input"
          onChange={(event) => {
            add(event.target.files)
            event.target.value = ''
          }}
        />
        <Button variant="primary" onClick={() => input.current?.click()}>
          Choose files
        </Button>
      </div>

      {uploads.length > 0 ? (
        <div className="mt-3 rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
            <h2 className="text-[13px] font-semibold text-ink">Uploads</h2>
            <p className="sr-only" aria-live="polite">
              {`${finished.length} of ${uploads.length} uploads finished${problems > 0 ? `, ${problems} with problems` : ''}`}
            </p>
            {finished.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => clearFinishedUploads(collectionId)}>
                Clear finished
              </Button>
            ) : null}
          </div>
          <ul className="divide-y divide-line">
            {uploads.map((item) => (
              <UploadRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function UploadRow({ item }: { item: UploadItem }) {
  const measurable = item.total !== null && item.total > 0
  const sent = measurable && item.loaded >= (item.total ?? 0)
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" data-testid="upload-row">
      <div className="mt-0.5 shrink-0">
        {item.status === 'done' ? (
          <CircleCheck size={16} className="text-success" aria-hidden="true" />
        ) : item.status === 'duplicate' ? (
          <Copy size={16} className="text-warning" aria-hidden="true" />
        ) : item.status === 'failed' || item.status === 'rejected' ? (
          <CircleAlert size={16} className="text-danger" aria-hidden="true" />
        ) : item.status === 'cancelled' ? (
          <X size={16} className="text-ink-3" aria-hidden="true" />
        ) : (
          <Spinner size={16} className="text-ink-3" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-sm">
          <span className="truncate font-medium text-ink">{item.name}</span>
          <span className="shrink-0 text-xs text-ink-3">{formatBytes(item.size)}</span>
        </p>
        {item.status === 'queued' ? <p className="text-[13px] text-ink-3">Waiting to upload</p> : null}
        {item.status === 'uploading' ? (
          <div className="mt-1.5">
            {/* Byte progress is shown only when the browser can measure the request body. */}
            <ProgressBar
              label={`Uploading ${item.name}`}
              value={measurable && !sent ? item.loaded / (item.total ?? 1) : null}
            />
            <p className="mt-1 text-[13px] text-ink-3">
              {sent
                ? 'Sent. Waiting for the server…'
                : measurable
                  ? `${formatBytes(item.loaded)} of ${formatBytes(item.total ?? 0)}`
                  : 'Uploading…'}
            </p>
          </div>
        ) : null}
        {item.status === 'done' ? <p className="text-[13px] text-ink-2">Uploaded. Indexing has started.</p> : null}
        {item.status === 'duplicate' ? (
          <p className="text-[13px] text-ink-2">
            Already in this workspace{item.documentTitle ? ` as “${item.documentTitle}”` : ''}. Nothing was stored twice.
          </p>
        ) : null}
        {item.status === 'failed' ? <p className="text-[13px] text-danger">{item.message ?? 'The upload failed.'}</p> : null}
        {item.status === 'rejected' ? <p className="text-[13px] text-danger">Not uploaded. {item.message}</p> : null}
        {item.status === 'cancelled' ? <p className="text-[13px] text-ink-3">Cancelled</p> : null}
      </div>
      {isActiveUpload(item) ? (
        <IconButton
          size="sm"
          label={`Cancel upload of ${item.name}`}
          icon={<X size={14} aria-hidden="true" />}
          onClick={() => cancelUpload(item.id)}
        />
      ) : null}
    </li>
  )
}

// ----------------------------------------------------------------------------- documents

interface DocumentListProps {
  documents: DocumentOut[]
  onRename: (document: DocumentOut) => void
  onDelete: (document: DocumentOut) => void
}

function DocumentList({ documents, onRename, onDelete }: DocumentListProps) {
  const table = useMediaQuery('(min-width: 768px)')
  if (!table) {
    return (
      <ul className="space-y-2">
        {documents.map((document) => (
          <li key={document.id} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <DocumentTitle document={document} />
              </div>
              <DocumentActions document={document} onRename={onRename} onDelete={onDelete} />
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
              <StatusBadge document={document} />
              <span>{kindLabel(document.kind)}</span>
              <span>{pagesLabel(document)}</span>
              <span>{formatBytes(document.size_bytes)}</span>
              <time dateTime={document.updated_at}>{formatRelative(document.updated_at)}</time>
            </p>
            <DocumentIssue document={document} />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-ink-3">
            <th scope="col" className="px-4 py-2 font-medium">
              Title
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Type
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Length
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Size
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Updated
            </th>
            <th scope="col" className="w-12 px-2 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {documents.map((document) => (
            <tr key={document.id} className="align-top">
              <td className="max-w-0 px-4 py-2.5" style={{ width: '45%' }}>
                <DocumentTitle document={document} />
                <DocumentIssue document={document} />
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">{kindLabel(document.kind)}</td>
              <td className="px-3 py-2.5 whitespace-nowrap text-ink-2 tabular-nums">{pagesLabel(document)}</td>
              <td className="px-3 py-2.5 whitespace-nowrap text-ink-2 tabular-nums">{formatBytes(document.size_bytes)}</td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                <StatusBadge document={document} />
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">
                <time dateTime={document.updated_at} title={formatDateTime(document.updated_at)}>
                  {formatRelative(document.updated_at)}
                </time>
              </td>
              <td className="px-2 py-1.5 text-right">
                <DocumentActions document={document} onRename={onRename} onDelete={onDelete} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function pagesLabel(document: DocumentOut): string {
  return document.page_count > 0 ? `${document.page_count} ${locatorNoun(document.locator_kind, document.page_count)}` : '—'
}

function DocumentTitle({ document }: { document: DocumentOut }) {
  return (
    <>
      <Link to={viewerPath({ documentId: document.id })} className="block truncate rounded-sm font-medium text-ink hover:text-accent">
        {document.title}
      </Link>
      {document.filename !== document.title ? <p className="truncate text-xs text-ink-3">{document.filename}</p> : null}
    </>
  )
}

/** What needs the user's attention for this document, with the action that resolves it. */
function DocumentIssue({ document }: { document: DocumentOut }) {
  const reindex = useReindexDocument()
  const toast = useToast()
  const state = documentState(document)

  let message: string | null = null
  let action: string | null = null
  let tone = 'text-warning'
  if (state === 'failed') {
    message = document.error ?? 'Indexing failed. The server did not record a reason.'
    action = 'Retry'
    tone = 'text-danger'
  } else if (state === 'stale') {
    message = 'Indexed with different models than the server uses now, so semantic search skips it until it is re-indexed.'
    action = 'Re-index'
  } else if (state === 'indexed' && document.error) {
    message = `The last re-index failed and the previous index was kept: ${document.error}`
    action = 'Retry'
  }
  if (!message) return null

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className={cx('min-w-0 text-[13px] break-words whitespace-normal', tone)}>{message}</p>
      {action ? (
        <Button
          size="sm"
          loading={reindex.isPending}
          aria-label={`${action} indexing of ${document.title}`}
          onClick={() =>
            reindex.mutate(document.id, {
              onError: (error) => toast({ tone: 'danger', title: 'Indexing could not be started', description: errorMessage(error) }),
            })
          }
        >
          {action}
        </Button>
      ) : null}
    </div>
  )
}

function DocumentActions({ document, onRename, onDelete }: { document: DocumentOut } & Omit<DocumentListProps, 'documents'>) {
  const reindex = useReindexDocument()
  const toast = useToast()
  const busy = isIndexing(document)
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Actions for ${document.title}`}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-subtle hover:text-ink"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLinkItem icon={<ExternalLink size={14} aria-hidden="true" />} to={viewerPath({ documentId: document.id })}>
          Open
        </MenuLinkItem>
        <MenuItem icon={<Pencil size={14} aria-hidden="true" />} onSelect={() => onRename(document)}>
          Rename…
        </MenuItem>
        <MenuItem
          icon={<RefreshCw size={14} aria-hidden="true" />}
          disabled={busy}
          onSelect={() =>
            reindex.mutate(document.id, {
              onSuccess: () => toast({ title: 'Indexing started', description: document.title }),
              onError: (error) => toast({ tone: 'danger', title: 'Indexing could not be started', description: errorMessage(error) }),
            })
          }
        >
          {document.status === 'failed' ? 'Retry indexing' : 'Re-index'}
        </MenuItem>
        <MenuLinkItem
          icon={<Download size={14} aria-hidden="true" />}
          href={documentFileUrl(document.id)}
          download={document.filename}
        >
          Download original
        </MenuLinkItem>
        <MenuSeparator />
        <MenuItem destructive icon={<Trash2 size={14} aria-hidden="true" />} onSelect={() => onDelete(document)}>
          Delete…
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function RenameDialog({ document, onClose }: { document: DocumentOut; onClose: () => void }) {
  const [title, setTitle] = useState(document.title)
  const rename = useRenameDocument()
  const trimmed = title.trim()

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (trimmed.length === 0) return
    if (trimmed === document.title) {
      onClose()
      return
    }
    rename.mutate({ id: document.id, title: trimmed }, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Rename document" description={`File: ${document.filename}`}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field label="Title" error={trimmed.length === 0 ? 'Enter a title.' : null}>
          {(control) => (
            <Input {...control} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={255} autoFocus />
          )}
        </Field>
        {rename.isError ? <Notice tone="danger">{errorMessage(rename.error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={rename.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function DeleteDocumentDialog({ document, onClose }: { document: DocumentOut | null; onClose: () => void }) {
  const remove = useDeleteDocument()
  const toast = useToast()
  if (!document) return null
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          remove.reset()
          onClose()
        }
      }}
      title={`Delete “${document.title}”?`}
      description="This removes the uploaded file, its extracted text and its passages from the search index. This cannot be undone."
      confirmLabel="Delete document"
      destructive
      pending={remove.isPending}
      error={remove.isError ? errorMessage(remove.error) : null}
      onConfirm={() =>
        remove.mutate(document, {
          onSuccess: () => {
            toast({ title: 'Document deleted', description: document.title })
            onClose()
          },
        })
      }
    />
  )
}
