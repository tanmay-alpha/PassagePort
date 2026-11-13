import { FileUp, FolderPlus, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { errorMessage } from '@/api/client'
import { useCollections, useCreateCollection, useSystem } from '@/api/queries'
import type { CollectionOut } from '@/api/types'
import {
  COLLECTION_NAME_MAX,
  CollectionFormDialog,
  DeleteCollectionDialog,
} from '@/components/collections/CollectionDialogs'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, Notice, Skeleton, Spinner } from '@/components/ui/Feedback'
import { Field, Input } from '@/components/ui/Form'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { Page, PageHeader } from '@/components/ui/Page'
import { formatBytes, formatRelative, plural } from '@/lib/format'
import { useDocumentTitle } from '@/lib/hooks'
import { sectionPath } from '@/lib/workspace'

export function Component() {
  useDocumentTitle('Workspaces')
  const collections = useCollections()

  if (collections.isPending) {
    return (
      <Page>
        <div role="status" aria-label="Loading workspaces" className="space-y-4">
          <Skeleton className="h-7 w-48" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
          </div>
        </div>
      </Page>
    )
  }
  if (collections.isError) {
    return (
      <Page>
        <Notice
          tone="danger"
          title="Your workspaces could not be loaded."
          action={
            <Button size="sm" onClick={() => void collections.refetch()}>
              Try again
            </Button>
          }
        >
          {errorMessage(collections.error)}
        </Notice>
      </Page>
    )
  }
  return collections.data.length === 0 ? <Onboarding /> : <Dashboard collections={collections.data} />
}

const STEPS = [
  {
    icon: FolderPlus,
    title: 'Create a workspace',
    body: 'A workspace keeps related documents together, such as a project, a course or a contract set.',
  },
  {
    icon: FileUp,
    title: 'Add documents',
    body: 'Upload PDF, Word, Markdown or plain-text files. Their text is extracted and indexed page by page.',
  },
  {
    icon: Search,
    title: 'Search with citations',
    body: 'Every result, answer and comparison links to the passage it came from, highlighted in the document.',
  },
] as const

function Onboarding() {
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const create = useCreateCollection()
  const navigate = useNavigate()
  const trimmed = name.trim()

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (trimmed.length === 0) return
    create.mutate({ name: trimmed, description: '' }, { onSuccess: (created) => void navigate(sectionPath(created.id, 'library')) })
  }

  return (
    <Page className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-[-0.015em] text-ink">Welcome to PassagePort</h1>
      <p className="mt-2 max-w-xl text-[15px] text-ink-2">
        Search your own documents and get answers that point to the exact page they came from.
      </p>

      <ol className="mt-8 grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center gap-2 text-ink-3">
              <step.icon size={16} aria-hidden="true" />
              <span className="text-xs font-medium">Step {index + 1}</span>
            </div>
            <h2 className="mt-3 text-sm font-semibold text-ink">{step.title}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{step.body}</p>
          </li>
        ))}
      </ol>

      <Card className="mt-6 p-5">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field
            label="Name your first workspace"
            className="flex-1"
            error={touched && trimmed.length === 0 ? 'Enter a name to continue.' : null}
          >
            {(control) => (
              <Input
                {...control}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={COLLECTION_NAME_MAX}
                placeholder="For example: Research papers"
                autoComplete="off"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={create.isPending} className="sm:mb-0">
            Create workspace
          </Button>
        </form>
        {create.isError ? (
          <Notice tone="danger" className="mt-3">
            {errorMessage(create.error)}
          </Notice>
        ) : null}
      </Card>
    </Page>
  )
}

function Dashboard({ collections }: { collections: CollectionOut[] }) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<CollectionOut | null>(null)
  const [deleting, setDeleting] = useState<CollectionOut | null>(null)
  const navigate = useNavigate()

  return (
    <Page>
      <PageHeader
        title="Workspaces"
        description="Each workspace is searched on its own. Open one to add documents, search, ask and compare."
        actions={
          <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>
            New workspace
          </Button>
        }
      />
      <ul className="grid gap-4 sm:grid-cols-2">
        {collections.map((collection) => (
          <li key={collection.id}>
            <WorkspaceCard collection={collection} onEdit={() => setEditing(collection)} onDelete={() => setDeleting(collection)} />
          </li>
        ))}
      </ul>
      <SystemStrip />

      <CollectionFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(created) => void navigate(sectionPath(created.id, 'library'))}
      />
      <CollectionFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        collection={editing ?? undefined}
      />
      <DeleteCollectionDialog collection={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </Page>
  )
}

function WorkspaceCard({ collection, onEdit, onDelete }: { collection: CollectionOut; onEdit: () => void; onDelete: () => void }) {
  const headingId = `workspace-${collection.id}`
  return (
    <article aria-labelledby={headingId} className="flex h-full flex-col rounded-lg border border-line bg-surface p-4 transition-colors duration-100 hover:border-line-strong">
      <div className="flex items-start gap-2">
        <h2 id={headingId} className="min-w-0 flex-1 text-[15px] font-semibold text-ink">
          <Link to={sectionPath(collection.id, 'library')} className="block truncate rounded-sm hover:text-accent">
            {collection.name}
          </Link>
        </h2>
        <Menu>
          <MenuTrigger
            aria-label={`Actions for ${collection.name}`}
            className="-mt-1 -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-subtle hover:text-ink"
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Pencil size={14} aria-hidden="true" />} onSelect={onEdit}>
              Rename or edit…
            </MenuItem>
            <MenuSeparator />
            <MenuItem destructive icon={<Trash2 size={14} aria-hidden="true" />} onSelect={onDelete}>
              Delete…
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {collection.description ? <p className="mt-1 line-clamp-2 text-[13px] text-ink-2">{collection.description}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge>{plural(collection.document_count, 'document')}</Badge>
        {collection.indexed_count > 0 ? <Badge tone="success">{`${collection.indexed_count} indexed`}</Badge> : null}
        {collection.processing_count > 0 ? (
          <Badge tone="accent">
            <Spinner size={10} />
            {`${collection.processing_count} processing`}
          </Badge>
        ) : null}
        {collection.failed_count > 0 ? <Badge tone="danger">{`${collection.failed_count} failed`}</Badge> : null}
      </div>

      <p className="mt-auto pt-4 text-xs text-ink-3">
        {plural(collection.chunk_count, 'passage')} · {formatBytes(collection.size_bytes)} · updated{' '}
        <time dateTime={collection.updated_at}>{formatRelative(collection.updated_at)}</time>
      </p>
    </article>
  )
}

/** Which models answer queries on this server, straight from /api/system. */
function SystemStrip() {
  const system = useSystem()
  if (!system.data) return null
  const { embedding, reranker, llm_configured, llm_model } = system.data
  const rerankerOn = reranker.enabled !== false
  return (
    <section aria-label="System status" className="mt-8 rounded-lg border border-line px-4 py-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
        <div className="flex gap-1.5">
          <dt className="text-ink-3">Embeddings</dt>
          <dd className="text-ink">{embedding.model}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-ink-3">Reranker</dt>
          <dd className="text-ink">{rerankerOn ? reranker.model : 'Off'}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-ink-3">Answers</dt>
          <dd className="text-ink">
            {llm_configured ? `Generated by ${llm_model ?? 'the configured model'}` : 'Extractive, no language model configured'}
          </dd>
        </div>
        <div className="ml-auto">
          <Link to="/settings" className="font-medium text-accent hover:underline">
            Settings and status
          </Link>
        </div>
      </dl>
    </section>
  )
}
