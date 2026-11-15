import * as RadixDialog from '@radix-ui/react-dialog'
import {
  Columns2,
  CornerDownLeft,
  FileText,
  FlaskConical,
  FolderOpen,
  Keyboard,
  LayoutGrid,
  LibraryBig,
  type LucideIcon,
  MessageSquareText,
  Moon,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  Upload,
} from 'lucide-react'
import { type KeyboardEvent, useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { useDocuments } from '@/api/queries'
import { useOpenerFocus } from '@/components/ui/Dialog'
import { Kbd } from '@/components/ui/Feedback'
import { cx } from '@/lib/cx'
import { kindLabel } from '@/lib/format'
import { filterEntries, matchScore, modifierLabel, type PaletteEntry } from '@/lib/palette'
import { setThemePreference, useTheme } from '@/lib/theme'
import { type ActiveWorkspace, type Section, sectionPath, viewerPath } from '@/lib/workspace'

interface Command extends PaletteEntry {
  group: string
  icon: LucideIcon
  hint?: string
  run: () => void
}

const SCREENS: Array<{ section: Section; label: string; icon: LucideIcon; keywords: string }> = [
  { section: 'library', label: 'Library', icon: LibraryBig, keywords: 'documents files upload' },
  { section: 'search', label: 'Search', icon: Search, keywords: 'find passages' },
  { section: 'ask', label: 'Ask', icon: MessageSquareText, keywords: 'question answer cite' },
  { section: 'compare', label: 'Compare', icon: Columns2, keywords: 'diff versions documents' },
  { section: 'lab', label: 'Search Lab', icon: FlaskConical, keywords: 'ranking stages evaluation' },
]

const DOCUMENT_LIMIT = 8
const WORKSPACE_LIMIT = 6

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: ActiveWorkspace
  onCreateWorkspace: () => void
  /** Opens the file picker for the active workspace; absent when there is none. */
  onUpload: (() => void) | null
  onLoadSamples: () => void
  onShowShortcuts: () => void
}

/**
 * Ctrl/⌘+K: jump to screens, workspaces and documents, run actions, or send the typed text
 * straight to Search, Ask or the Search Lab. A combobox with a listbox: focus stays in the
 * input and arrow keys move the active option (aria-activedescendant).
 */
export function CommandPalette(props: CommandPaletteProps) {
  const focusEvents = useOpenerFocus()
  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay" />
        <RadixDialog.Content
          {...focusEvents}
          aria-describedby={undefined}
          className={cx(
            'fixed top-[max(1rem,12dvh)] left-1/2 z-50 flex max-h-[min(34rem,calc(100dvh-2rem))] w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 flex-col',
            'animate-pop-in overflow-hidden rounded-xl border border-line bg-surface shadow-pop',
          )}
        >
          <RadixDialog.Title className="sr-only">Command menu</RadixDialog.Title>
          {/* Remounted per opening so the query and selection start fresh. */}
          {props.open ? <PaletteBody {...props} /> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function PaletteBody({ onOpenChange, workspace, onCreateWorkspace, onUpload, onLoadSamples, onShowShortcuts }: CommandPaletteProps) {
  const navigate = useNavigate()
  const theme = useTheme()
  const active = workspace.active
  const documents = useDocuments(active?.id)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  const trimmed = query.trim()

  const commands = useMemo(() => {
    const go = (path: string) => () => void navigate(path)
    const list: Command[] = []
    const runs: Command[] = []
    if (active && trimmed !== '') {
      const q = encodeURIComponent(trimmed)
      runs.push(
        { id: 'run-search', group: 'Run', label: `Search for “${trimmed}”`, hint: active.name, icon: Search, run: go(`${sectionPath(active.id, 'search')}?q=${q}`) },
        { id: 'run-ask', group: 'Run', label: `Ask “${trimmed}”`, hint: active.name, icon: MessageSquareText, run: go(`${sectionPath(active.id, 'ask')}?q=${q}`) },
        { id: 'run-lab', group: 'Run', label: `Inspect “${trimmed}” in Search Lab`, hint: active.name, icon: FlaskConical, run: go(`${sectionPath(active.id, 'lab')}?q=${q}`) },
      )
    }
    const filtered = (entries: Command[], limit?: number) => filterEntries(entries, trimmed, limit)

    if (active) {
      list.push(
        ...filtered(
          SCREENS.map((screen) => ({
            id: `screen-${screen.section}`,
            group: 'Go to',
            label: screen.label,
            keywords: screen.keywords,
            hint: active.name,
            icon: screen.icon,
            run: go(sectionPath(active.id, screen.section)),
          })),
        ),
      )
    }
    list.push(
      ...filtered([
        { id: 'screen-home', group: 'Go to', label: 'All workspaces', keywords: 'home dashboard', icon: LayoutGrid, run: go('/') },
        { id: 'screen-settings', group: 'Go to', label: 'Settings', keywords: 'status models account tokens', icon: Settings, run: go('/settings') },
      ]),
    )

    list.push(
      ...filtered(
        (documents.data ?? []).map((document) => ({
          id: `document-${document.id}`,
          group: active ? `Documents in ${active.name}` : 'Documents',
          label: document.title,
          keywords: document.filename,
          hint: kindLabel(document.kind),
          icon: FileText,
          run: go(viewerPath({ documentId: document.id })),
        })),
        DOCUMENT_LIMIT,
      ),
    )

    list.push(
      ...filtered(
        (workspace.collections ?? []).map((collection) => ({
          id: `workspace-${collection.id}`,
          group: 'Workspaces',
          label: collection.name,
          keywords: `workspace ${collection.description}`,
          hint: collection.id === active?.id ? 'Current' : undefined,
          icon: FolderOpen,
          run: go(sectionPath(collection.id, 'library')),
        })),
        WORKSPACE_LIMIT,
      ),
    )

    const dark = theme.resolved === 'dark'
    const actions: Command[] = [
      { id: 'action-new-workspace', group: 'Actions', label: 'New workspace…', keywords: 'create collection', icon: Plus, run: onCreateWorkspace },
    ]
    if (onUpload && active) {
      actions.push({ id: 'action-upload', group: 'Actions', label: 'Upload documents…', keywords: 'add files import', hint: active.name, icon: Upload, run: onUpload })
    }
    actions.push(
      { id: 'action-samples', group: 'Actions', label: 'Load sample documents', keywords: 'demo example try', icon: Sparkles, run: onLoadSamples },
      {
        id: 'action-theme',
        group: 'Actions',
        label: dark ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: 'toggle theme appearance dark light mode',
        icon: dark ? Sun : Moon,
        run: () => setThemePreference(dark ? 'light' : 'dark'),
      },
      { id: 'action-shortcuts', group: 'Actions', label: 'Keyboard shortcuts', keywords: 'help keys', icon: Keyboard, run: onShowShortcuts },
    )
    list.push(...filtered(actions))
    // A query that names a screen, document or command opens it on Enter; anything else
    // is most likely a question, so running it as a search comes first.
    const named = list.some((command) => (matchScore(command, trimmed) ?? Infinity) <= 1)
    return named ? [...list, ...runs] : [...runs, ...list]
  }, [active, trimmed, documents.data, workspace.collections, theme.resolved, navigate, onCreateWorkspace, onUpload, onLoadSamples, onShowShortcuts])

  const current = Math.min(activeIndex, commands.length - 1)
  const groups = useMemo(() => {
    const result: Array<{ name: string; items: Array<{ command: Command; index: number }> }> = []
    commands.forEach((command, index) => {
      const last = result.at(-1)
      if (last?.name === command.group) last.items.push({ command, index })
      else result.push({ name: command.group, items: [{ command, index }] })
    })
    return result
  }, [commands])

  function runCommand(command: Command) {
    onOpenChange(false)
    command.run()
  }

  function move(index: number) {
    setActiveIndex(index)
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (commands.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move((current + 1) % commands.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move((current - 1 + commands.length) % commands.length)
    } else if (event.key === 'PageDown' || (event.key === 'End' && event.ctrlKey)) {
      event.preventDefault()
      move(commands.length - 1)
    } else if (event.key === 'PageUp' || (event.key === 'Home' && event.ctrlKey)) {
      event.preventDefault()
      move(0)
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const command = commands[current]
      if (command) runCommand(command)
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      onOpenChange(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search size={18} className="shrink-0 text-ink-3" aria-hidden="true" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={commands.length > 0 ? optionId(current) : undefined}
          aria-label="Search commands, documents and workspaces"
          placeholder={active ? `Search ${active.name}, jump to a document or run a command…` : 'Jump to a workspace or run a command…'}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
          className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
        />
        <span className="hidden sm:inline-flex">
          <Kbd>Esc</Kbd>
        </span>
      </div>
      <div id={listId} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {commands.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-ink-3">{`Nothing matches “${trimmed}”.`}</p>
        ) : (
          groups.map((group) => {
            const headingId = `${listId}-${group.name.replace(/\W+/g, '-')}`
            return (
              <div key={group.name} role="group" aria-labelledby={headingId} className="mb-1 last:mb-0">
                <div id={headingId} className="truncate px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-[0.06em] text-ink-3 uppercase">
                  {group.name}
                </div>
                {group.items.map(({ command, index }) => {
                  const selected = index === current
                  const Icon = command.icon
                  return (
                    // Keyboard interaction lives on the combobox input (aria-activedescendant).
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                    <div
                      key={command.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      onMouseMove={() => {
                        if (!selected) setActiveIndex(index)
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => runCommand(command)}
                      className={cx(
                        'flex h-10 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-sm',
                        selected ? 'bg-subtle text-ink' : 'text-ink-2',
                      )}
                    >
                      <Icon size={16} className={cx('shrink-0', selected ? 'text-accent' : 'text-ink-3')} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {command.hint ? <span className="max-w-[40%] shrink-0 truncate text-xs text-ink-3">{command.hint}</span> : null}
                      {selected ? <CornerDownLeft size={14} className="shrink-0 text-ink-3" aria-hidden="true" /> : null}
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>
      <div className="hidden items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-3 sm:flex">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd> open
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <Kbd>{modifierLabel()}</Kbd>
          <Kbd>K</Kbd> toggle
        </span>
      </div>
    </>
  )
}
