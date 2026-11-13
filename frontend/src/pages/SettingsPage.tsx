import { Check, Copy, KeyRound, Trash2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { useLocation } from 'react-router'

import { errorMessage } from '@/api/client'
import { useApiTokens, useCreateApiToken, useRevokeApiToken, useSession, useSignOut, useSystem } from '@/api/queries'
import type { ApiTokenOut, SessionOut, SystemOut } from '@/api/types'
import { ShortcutList } from '@/components/shell/Shortcuts'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { Card, Notice, ProgressBar, Skeleton } from '@/components/ui/Feedback'
import { Field, Input, SegmentedControl } from '@/components/ui/Form'
import { Page, PageHeader, SectionHeading } from '@/components/ui/Page'
import { useToast } from '@/components/ui/Toast'
import { formatBytes, formatCount, formatDateTime } from '@/lib/format'
import { useDocumentTitle } from '@/lib/hooks'
import { setThemePreference, type ThemePreference, useTheme } from '@/lib/theme'

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Environment variables the server reads to enable generated answers. */
const LLM_VARIABLES: Array<[string, string]> = [
  ['PP_LLM_BASE_URL', 'Base URL of an OpenAI-compatible chat-completions API'],
  ['PP_LLM_MODEL', 'Model name to request'],
  ['PP_LLM_API_KEY', 'API key, if the endpoint needs one'],
]

export function Component() {
  useDocumentTitle('Settings')
  const theme = useTheme()
  const system = useSystem()
  const session = useSession()
  const { hash } = useLocation()
  const systemReady = system.isSuccess

  // Links such as /settings#answers point at a section that only exists once status has loaded.
  useEffect(() => {
    if (hash.length > 1 && systemReady) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash, systemReady])

  return (
    <Page className="max-w-3xl">
      <PageHeader title="Settings and status" />
      <div className="space-y-8">
        <Section id="appearance" title="Appearance">
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-sm font-medium text-ink">Theme</p>
              <p className="text-[13px] text-ink-2">
                {theme.preference === 'system' ? `Following your system (${theme.resolved}).` : 'Saved in this browser.'}
              </p>
            </div>
            <SegmentedControl label="Theme" value={theme.preference} onValueChange={setThemePreference} options={THEME_OPTIONS} />
          </Card>
        </Section>

        {system.isPending ? (
          <div role="status" aria-label="Loading system status" className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : system.isError ? (
          <Notice
            tone="danger"
            title="The system status could not be loaded."
            action={
              <Button size="sm" onClick={() => void system.refetch()}>
                Try again
              </Button>
            }
          >
            {errorMessage(system.error)}
          </Notice>
        ) : (
          <SystemSections system={system.data} />
        )}

        {session.data?.auth_mode === 'accounts' && session.data.user ? <Account session={session.data} /> : null}

        <Section id="shortcuts" title="Keyboard shortcuts">
          <Card className="px-4 py-1">
            <ShortcutList />
          </Card>
        </Section>
      </div>
    </Page>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-6">
      <SectionHeading id={`${id}-heading`} className="mb-3">
        {title}
      </SectionHeading>
      {children}
    </section>
  )
}

function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-line text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap justify-between gap-x-6 gap-y-0.5 px-4 py-2.5">
          <dt className="text-ink-2">{label}</dt>
          <dd className="min-w-0 text-right break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Usage({ label, used, limit, format }: { label: string; used: number; limit: number; format: (value: number) => string }) {
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex justify-between gap-4 text-sm">
        <span className="text-ink-2">{label}</span>
        <span className="text-ink tabular-nums">
          {format(used)} of {format(limit)}
        </span>
      </div>
      <ProgressBar label={label} value={limit > 0 ? used / limit : 0} />
    </div>
  )
}

function SystemSections({ system }: { system: SystemOut }) {
  const { embedding, reranker, limits, usage } = system
  const rerankerOn = reranker.enabled !== false
  return (
    <>
      <Section id="answers" title="Answers">
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-ink">Language model</p>
            {system.llm_configured ? <Badge tone="success">Configured</Badge> : <Badge>Not configured</Badge>}
          </div>
          {system.llm_configured ? (
            <p className="mt-1 text-[13px] text-ink-2">
              Ask and Compare use <span className="font-medium text-ink">{system.llm_model ?? 'the configured model'}</span> to
              write answers from retrieved passages. Generated text is labelled, and sentences without a citation are flagged.
            </p>
          ) : (
            <>
              <p className="mt-1 text-[13px] text-ink-2">
                Without a language model, Ask returns verbatim excerpts with citations and Compare shows only what is
                computed from the text. To enable generated answers, set these environment variables on the server and
                restart it:
              </p>
              <dl className="mt-3 space-y-1.5 text-[13px]">
                {LLM_VARIABLES.map(([name, purpose]) => (
                  <div key={name} className="flex flex-wrap items-baseline gap-x-3">
                    <dt>
                      <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-ink">{name}</code>
                    </dt>
                    <dd className="text-ink-2">{purpose}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </Card>
      </Section>

      <Section id="system" title="System">
        <Card>
          <Rows
            rows={[
              ['Version', system.version],
              ['Access mode', system.auth_mode === 'local' ? 'Local, single user' : 'Accounts'],
              ['Database', system.database === 'sqlite' ? 'SQLite' : 'PostgreSQL'],
              ['File storage', system.blob_backend === 'fs' ? 'Server file system' : 'Database'],
              [
                'Embedding model',
                <>
                  {embedding.model}
                  <span className="text-ink-3">
                    {' '}
                    · {embedding.backend}
                    {embedding.dimensions ? ` · ${embedding.dimensions} dimensions` : ''} · {embedding.loaded ? 'loaded' : 'loads on first use'}
                  </span>
                </>,
              ],
              [
                'Reranker',
                rerankerOn ? (
                  <>
                    {reranker.model}
                    <span className="text-ink-3">
                      {' '}
                      · {reranker.backend} · {reranker.loaded ? 'loaded' : 'loads on first use'}
                    </span>
                  </>
                ) : (
                  'Off'
                ),
              ],
              ['Indexing jobs waiting', formatCount(system.pending_jobs)],
            ]}
          />
        </Card>
      </Section>

      <Section id="usage" title="Usage and limits">
        <Card className="divide-y divide-line">
          <Usage label="Documents" used={usage.documents} limit={limits.max_documents} format={formatCount} />
          <Usage label="Storage" used={usage.storage_bytes} limit={limits.max_storage_bytes} format={formatBytes} />
          <Rows
            rows={[
              ['Workspaces', formatCount(usage.collections)],
              ['Indexed passages', formatCount(usage.chunks)],
              ['Largest upload', formatBytes(limits.max_upload_bytes)],
              ['Accepted file types', limits.allowed_extensions.map((extension) => `.${extension.replace(/^\./, '')}`).join(', ')],
              ['Longest query', `${formatCount(limits.max_query_chars)} characters`],
            ]}
          />
        </Card>
      </Section>
    </>
  )
}

// ----------------------------------------------------------------------------- account

function Account({ session }: { session: SessionOut }) {
  const signOut = useSignOut()
  const user = session.user
  if (!user) return null
  return (
    <Section id="account" title="Account">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium text-ink">{user.is_guest ? 'Guest session' : user.username}</p>
          <p className="text-[13px] text-ink-2">
            {user.is_guest ? 'Temporary. Documents are removed when the session expires.' : 'Signed in on this browser.'}
          </p>
        </div>
        <Button loading={signOut.isPending} onClick={() => signOut.mutate()}>
          Sign out
        </Button>
      </Card>
      {signOut.isError ? (
        <Notice tone="danger" className="mt-3">
          {errorMessage(signOut.error)}
        </Notice>
      ) : null}
      <ApiTokens />
    </Section>
  )
}

function ApiTokens() {
  const tokens = useApiTokens(true)
  const create = useCreateApiToken()
  const [name, setName] = useState('')
  const [revealed, setRevealed] = useState<ApiTokenOut | null>(null)
  const [revoking, setRevoking] = useState<ApiTokenOut | null>(null)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') return
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (token) => {
          setRevealed(token)
          setName('')
        },
      },
    )
  }

  return (
    <div className="mt-6">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <KeyRound size={14} aria-hidden="true" />
        API tokens
      </h3>
      <p className="mt-1 text-[13px] text-ink-2">
        For scripts and tools that call the API as you. Send one as{' '}
        <code className="rounded bg-subtle px-1 py-0.5 font-mono text-xs">Authorization: Bearer &lt;token&gt;</code>.
      </p>

      {revealed?.token ? <RevealedToken token={revealed} onDismiss={() => setRevealed(null)} /> : null}

      <Card className="mt-3">
        {tokens.isPending ? (
          <div className="p-4" role="status" aria-label="Loading API tokens">
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : tokens.isError ? (
          <div className="p-4">
            <Notice tone="danger">{errorMessage(tokens.error)}</Notice>
          </div>
        ) : tokens.data.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-ink-2">No API tokens yet.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="API tokens">
            {tokens.data.map((token) => (
              <li key={token.id} className="flex items-center gap-3 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{token.name}</p>
                  <p className="text-xs text-ink-3">Created {formatDateTime(token.created_at)}</p>
                </div>
                <IconButton
                  size="sm"
                  label={`Revoke token ${token.name}`}
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  onClick={() => setRevoking(token)}
                />
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2 border-t border-line p-4">
          <Field label="New token name" className="min-w-0 flex-1">
            {(control) => (
              <Input
                {...control}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                placeholder="For example: laptop script"
                autoComplete="off"
              />
            )}
          </Field>
          <Button type="submit" loading={create.isPending} disabled={name.trim() === ''}>
            Create token
          </Button>
        </form>
        {create.isError ? (
          <div className="px-4 pb-4">
            <Notice tone="danger">{errorMessage(create.error)}</Notice>
          </div>
        ) : null}
      </Card>

      <RevokeDialog token={revoking} onClose={() => setRevoking(null)} />
    </div>
  )
}

function RevealedToken({ token, onDismiss }: { token: ApiTokenOut; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  const value = token.token ?? ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      toast({ tone: 'danger', title: 'Could not copy', description: 'Select the token and copy it manually.' })
    }
  }

  return (
    <div role="status" className="mt-3 rounded-lg border border-accent/40 bg-accent-soft p-4">
      <p className="text-sm font-medium text-ink">Token “{token.name}” created</p>
      <p className="mt-0.5 text-[13px] text-ink-2">Copy it now. It is shown only once and cannot be retrieved later.</p>
      <div className="mt-3 flex items-center gap-2">
        <Input readOnly value={value} aria-label="New API token" className="min-w-0 flex-1 font-mono text-xs" onFocus={(event) => event.target.select()} />
        <Button
          icon={copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  )
}

function RevokeDialog({ token, onClose }: { token: ApiTokenOut | null; onClose: () => void }) {
  const revoke = useRevokeApiToken()
  if (!token) return null
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          revoke.reset()
          onClose()
        }
      }}
      title={`Revoke “${token.name}”?`}
      description="Anything using this token stops working immediately. This cannot be undone."
      confirmLabel="Revoke token"
      destructive
      pending={revoke.isPending}
      error={revoke.isError ? errorMessage(revoke.error) : null}
      onConfirm={() => revoke.mutate(token.id, { onSuccess: onClose })}
    />
  )
}
