import { useQueryClient } from '@tanstack/react-query'
import { Command, Menu as MenuIcon, Search } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router'

import { errorMessage } from '@/api/client'
import { invalidateLibrary, useSession, useSystem } from '@/api/queries'
import type { SessionOut } from '@/api/types'
import { CollectionFormDialog } from '@/components/collections/CollectionDialogs'
import { Logo } from '@/components/Logo'
import { Button, IconButton } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Dialog'
import { EmptyState, Spinner } from '@/components/ui/Feedback'
import { useToast } from '@/components/ui/Toast'
import { DESKTOP_QUERY, isEditableTarget, useMediaQuery, useWindowKeydown } from '@/lib/hooks'
import { useLoadSamples } from '@/lib/samples'
import { enqueueUploads } from '@/lib/uploads'
import { SEARCH_INPUT_ID, sectionPath, useActiveWorkspace } from '@/lib/workspace'

import { CommandPalette } from './CommandPalette'
import { ConnectivityBanner } from './ConnectivityBanner'
import { DropOverlay } from './DropOverlay'
import { ShortcutsDialog } from './Shortcuts'
import { Sidebar } from './Sidebar'

/** Layout route for every signed-in screen; redirects to /login when accounts mode needs it. */
export function AppShell() {
  const session = useSession()
  const location = useLocation()

  if (session.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-2">
        <Spinner label="Loading PassagePort…" />
      </div>
    )
  }
  if (session.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <EmptyState
          title="PassagePort can’t reach its server"
          description={errorMessage(session.error)}
          action={
            <Button variant="primary" loading={session.isFetching} onClick={() => void session.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }
  if (session.data.auth_mode === 'accounts' && !session.data.authenticated) {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
  }
  return <Shell session={session.data} />
}

function Shell({ session }: { session: SessionOut }) {
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const workspace = useActiveWorkspace()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const system = useSystem()
  const queryClient = useQueryClient()
  const toast = useToast()
  const samples = useLoadSamples()
  const fileInput = useRef<HTMLInputElement>(null)

  // Files dropped or picked from the shell go to the workspace on screen (also while one of
  // its documents is open); elsewhere there is no unambiguous target.
  const inWorkspace = params.collectionId !== undefined || params.documentId !== undefined
  const uploadTarget = inWorkspace ? workspace.active : null
  const limits = system.data?.limits
  const extensions = limits?.allowed_extensions.map((extension) => `.${extension.replace(/^\./, '').toLowerCase()}`)

  function addFiles(files: File[]) {
    if (!uploadTarget || !limits || files.length === 0) return
    const collectionId = uploadTarget.id
    enqueueUploads(collectionId, files, limits, () => invalidateLibrary(queryClient, collectionId))
    // The library lists the uploads with their real progress.
    const library = sectionPath(collectionId, 'library')
    if (location.pathname !== library) void navigate(library)
  }

  const openFilePicker = useCallback(() => fileInput.current?.click(), [])
  const openCreate = useCallback(() => setCreateOpen(true), [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const { start: startSamples } = samples
  const loadSamples = useCallback(() => {
    void startSamples().then((message) => {
      if (message) toast({ tone: 'danger', title: 'The sample documents could not be loaded', description: message })
    })
  }, [startSamples, toast])

  function goToSearch() {
    if (!workspace.active) {
      void navigate('/')
      return
    }
    const target = sectionPath(workspace.active.id, 'search')
    if (location.pathname === target) {
      const input = document.getElementById(SEARCH_INPUT_ID)
      if (input instanceof HTMLInputElement) {
        input.focus()
        input.select()
      }
      return
    }
    void navigate(target, { state: { focusQuery: true } })
  }

  useWindowKeydown((event) => {
    if (event.defaultPrevented) return
    const inOverlay = event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')
    if (inOverlay) return
    const modifier = event.ctrlKey || event.metaKey
    if (modifier && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      setPaletteOpen(true)
      return
    }
    if (modifier || event.altKey || isEditableTarget(event.target)) return
    if (event.key === '/') {
      event.preventDefault()
      goToSearch()
    } else if (event.key === '?') {
      event.preventDefault()
      setShortcutsOpen(true)
    }
  })

  const sidebar = (
    <Sidebar
      workspace={workspace}
      session={session}
      onNavigate={() => setDrawerOpen(false)}
      onOpenPalette={() => {
        setDrawerOpen(false)
        setPaletteOpen(true)
      }}
      onCreateWorkspace={() => {
        setDrawerOpen(false)
        setCreateOpen(true)
      }}
      onShowShortcuts={() => {
        setDrawerOpen(false)
        setShortcutsOpen(true)
      }}
    />
  )

  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      <a href="#main" className="pp-skip-link">
        Skip to content
      </a>
      {desktop ? (
        <aside aria-label="Sidebar" className="w-64 shrink-0 border-r border-line bg-sidebar">
          {sidebar}
        </aside>
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-bg/90 px-2 backdrop-blur">
          <IconButton label="Open navigation" icon={<MenuIcon size={18} aria-hidden="true" />} onClick={() => setDrawerOpen(true)} />
          <Link to="/" className="rounded-md px-1" aria-label="PassagePort home">
            <Logo size={22} />
          </Link>
          <span className="flex-1" />
          <IconButton label="Search this workspace" icon={<Search size={18} aria-hidden="true" />} onClick={goToSearch} />
          <IconButton label="Open command menu" icon={<Command size={18} aria-hidden="true" />} onClick={() => setPaletteOpen(true)} />
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen} title="Navigation" side="left">
            {sidebar}
          </Sheet>
        </header>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectivityBanner />
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <Outlet />
        </main>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={extensions?.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="shell-file-input"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <DropOverlay
        targetName={uploadTarget && limits ? uploadTarget.name : null}
        accepts={extensions ? `${extensions.join(', ')}` : null}
        onDrop={addFiles}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        workspace={workspace}
        onCreateWorkspace={openCreate}
        onUpload={uploadTarget ? openFilePicker : null}
        onLoadSamples={loadSamples}
        onShowShortcuts={openShortcuts}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <CollectionFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(collection) => void navigate(sectionPath(collection.id, 'library'))}
      />
    </div>
  )
}
