import { FileText, FileUp, FolderPlus, MoreHorizontal, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
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
import { SAMPLE_FILES, useLoadSamples } from '@/lib/samples'
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
    <Page className="max-w-4xl">
      <div className="pp-hero -mx-4 rounded-2xl px-4 pt-6 pb-2 sm:-mx-6 sm:px-6 sm:pt-10">
        <p className="text-[13px] font-medium text-accent">Search · Cite · Ask · Compare</p>
        <h1 className="mt-2 font-serif text-[2rem] leading-tight font-semibold tracking-[-0.02em] text-ink sm:text-[2.5rem]">
          Welcome to PassagePort
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-2">
          Search your own documents and get answers that point to the exact page they came from.
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-[1.1fr_1fr]">
        <SampleCard />
        <Card className="flex flex-col p-5">
          <h2 className="text-[15px] font-semibold text-ink">Start with your own documents</h2>
          <p className="mt-1 text-[13px] text-ink-2">Create an empty workspace, then add PDF, Word, Markdown or text files.</p>
          <form onSubmit={onSubmit} noValidate className="mt-auto flex flex-col gap-3 pt-5">
            <Field label="Name your first workspace" error={touched && trimmed.length === 0 ? 'Enter a name to continue.' : null}>
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
            <Button type="submit" variant="secondary" loading={create.isPending} className="self-start">
              Create workspace
            </Button>
          </form>
          {create.isError ? (
            <Notice tone="danger" className="mt-3">
              {errorMessage(create.error)}
            </Notice>
          ) : null}
        </Card>
      </div>

      <section aria-labelledby="how-it-works" className="mt-10">
        <h2 id="how-it-works" className="text-xs font-medium tracking-[0.06em] text-ink-3 uppercase">
          How it works
        </h2>
        <ol className="mt-3 grid gap-x-6 gap-y-5 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-xs font-semibold text-ink-2 tabular-nums">
                {index + 1}
              </span>
              <div>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <step.icon size={14} className="text-ink-3" aria-hidden="true" />
                  {step.title}
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </Page>
  )
}

const SAMPLE_PHASE_LABELS = {
  idle: 'Load sample documents',
  fetching: 'Downloading samples…',
  creating: 'Creating workspace…',
} as const

/** One click to a populated workspace: the bundled samples go through the real upload API. */
function SampleCard() {
  const samples = useLoadSamples()
  const busy = samples.phase !== 'idle'
  return (
    <Card className="relative overflow-hidden border-accent/30 p-5 shadow-[0_1px_0_var(--pp-line),0_12px_32px_-18px_color-mix(in_srgb,var(--pp-accent)_45%,transparent)]">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-accent text-on-accent">
          <Sparkles size={14} aria-hidden="true" />
        </span>
        <h2 className="text-[15px] font-semibold text-ink">Try it in one click</h2>
      </div>
      <p className="mt-2 text-[13px] text-ink-2">
        Loads four small sample files into a new workspace and indexes them, so you can search, ask and compare right away.
      </p>
      <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-bg/60" aria-label="Sample files">
        {SAMPLE_FILES.map((file) => (
          <li key={file.name} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
            <FileText size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-ink">{file.description}</span>
            <span className="shrink-0 font-mono text-[11px] text-ink-3">{file.name.split('.').pop()?.toUpperCase()}</span>
          </li>
        ))}
      </ul>
      <Button
        variant="primary"
        className="mt-4"
        loading={busy}
        disabled={!samples.ready}
        icon={<Sparkles size={15} aria-hidden="true" />}
        onClick={() => void samples.start()}
      >
        {SAMPLE_PHASE_LABELS[samples.phase]}
      </Button>
      {samples.error ? (
        <Notice tone="danger" className="mt-3" title="The samples could not be loaded.">
          {samples.error}
        </Notice>
      ) : null}
    </Card>
  )
}

function Dashboard({ collections }: { collections: CollectionOut[] }) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<CollectionOut | null>(null)
  const [deleting, setDeleting] = useState<CollectionOut | null>(null)
  const navigate = useNavigate()
  const samples = useLoadSamples()

  return (
    <Page>
      <PageHeader
        title="Workspaces"
        description="Each workspace is searched on its own. Open one to add documents, search, ask and compare."
        actions={
          <>
            <Button
              loading={samples.phase !== 'idle'}
              disabled={!samples.ready}
              icon={<Sparkles size={15} aria-hidden="true" />}
              onClick={() => void samples.start()}
            >
              {SAMPLE_PHASE_LABELS[samples.phase]}
            </Button>
            <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>
              New workspace
            </Button>
          </>
        }
      />
      {samples.error ? (
        <Notice tone="danger" className="mb-4" title="The samples could not be loaded.">
          {samples.error}
        </Notice>
      ) : null}
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
