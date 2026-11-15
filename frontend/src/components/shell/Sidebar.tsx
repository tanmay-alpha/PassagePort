import {
  Check,
  ChevronsUpDown,
  CircleUser,
  Columns2,
  FlaskConical,
  Keyboard,
  LayoutGrid,
  LibraryBig,
  LogOut,
  type LucideIcon,
  MessageSquareText,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
} from 'lucide-react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router'

import { errorMessage } from '@/api/client'
import { useSignOut } from '@/api/queries'
import type { SessionOut } from '@/api/types'
import { Logo } from '@/components/Logo'
import { IconButton } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Feedback'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { useToast } from '@/components/ui/Toast'
import { cx } from '@/lib/cx'
import { modifierLabel } from '@/lib/palette'
import { setThemePreference, useTheme } from '@/lib/theme'
import { type ActiveWorkspace, type Section, sectionPath, SECTIONS } from '@/lib/workspace'

const NAV: Array<{ section: Section; label: string; icon: LucideIcon }> = [
  { section: 'library', label: 'Library', icon: LibraryBig },
  { section: 'search', label: 'Search', icon: Search },
  { section: 'ask', label: 'Ask', icon: MessageSquareText },
  { section: 'compare', label: 'Compare', icon: Columns2 },
  { section: 'lab', label: 'Search Lab', icon: FlaskConical },
]

const ITEM = 'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium transition-colors duration-100'
const ITEM_IDLE = 'text-ink-2 hover:bg-sidebar-hover hover:text-ink'
const ITEM_ACTIVE = 'bg-surface text-ink shadow-[0_0_0_1px_var(--pp-line),0_1px_2px_rgb(0_0_0/0.04)]'

function currentSection(pathname: string): Section {
  const tail = pathname.split('/')[3]
  return SECTIONS.find((section) => section === tail) ?? 'library'
}

export interface SidebarProps {
  workspace: ActiveWorkspace
  session: SessionOut
  /** Called after any navigation so the mobile drawer can close. */
  onNavigate: () => void
  onOpenPalette: () => void
  onCreateWorkspace: () => void
  onShowShortcuts: () => void
}

export function Sidebar({ workspace, session, onNavigate, onOpenPalette, onCreateWorkspace, onShowShortcuts }: SidebarProps) {
  const { active, collections } = workspace
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useTheme()
  const dark = theme.resolved === 'dark'

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Link to="/" onClick={onNavigate} className="mx-1 mt-1 mb-1 inline-flex self-start rounded-md" aria-label="PassagePort home">
        <Logo />
      </Link>

      <Menu>
        <MenuTrigger
          className="flex h-10 w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-2 text-left text-sm transition-colors duration-100 hover:border-line-strong"
          aria-label={active ? `Workspace: ${active.name}. Switch workspace` : 'Choose a workspace'}
        >
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-xs font-semibold text-accent uppercase"
          >
            {active ? active.name.trim().charAt(0) || '·' : '·'}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-ink">
            {active ? active.name : workspace.isPending ? 'Loading…' : 'No workspace yet'}
          </span>
          <ChevronsUpDown size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
        </MenuTrigger>
        <MenuContent className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56">
          <MenuLabel>Workspaces</MenuLabel>
          {collections?.map((collection) => (
            <MenuItem
              key={collection.id}
              icon={collection.id === active?.id ? <Check size={14} aria-hidden="true" /> : <span />}
              onSelect={() => {
                void navigate(sectionPath(collection.id, currentSection(location.pathname)))
                onNavigate()
              }}
            >
              {collection.name}
            </MenuItem>
          ))}
          {collections?.length === 0 ? <p className="px-2 py-1 text-[13px] text-ink-3">None yet.</p> : null}
          <MenuSeparator />
          <MenuItem icon={<Plus size={14} aria-hidden="true" />} onSelect={onCreateWorkspace}>
            New workspace…
          </MenuItem>
          <MenuItem
            icon={<LayoutGrid size={14} aria-hidden="true" />}
            onSelect={() => {
              void navigate('/')
              onNavigate()
            }}
          >
            All workspaces
          </MenuItem>
        </MenuContent>
      </Menu>

      <button
        type="button"
        onClick={onOpenPalette}
        aria-keyshortcuts="Control+K Meta+K"
        className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-ink-3 transition-colors duration-100 hover:bg-sidebar-hover hover:text-ink-2"
      >
        <Search size={15} aria-hidden="true" />
        <span className="flex-1">Search or jump to…</span>
        <span className="inline-flex items-center gap-0.5" aria-hidden="true">
          <Kbd>{modifierLabel()}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <nav aria-label="Workspace" className="flex flex-col gap-0.5">
        <p className="px-2.5 pt-1 pb-1 text-[11px] font-medium tracking-[0.06em] text-ink-3 uppercase" aria-hidden="true">
          Workspace
        </p>
        {NAV.map(({ section, label, icon: Icon }) =>
          active ? (
            <NavLink
              key={section}
              to={sectionPath(active.id, section)}
              end={section === 'library'}
              onClick={onNavigate}
              className={({ isActive }) => cx(ITEM, isActive ? ITEM_ACTIVE : ITEM_IDLE)}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </NavLink>
          ) : (
            <span
              key={section}
              aria-disabled="true"
              title="Create a workspace first"
              className={cx(ITEM, 'cursor-not-allowed text-ink-3 opacity-60')}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </span>
          ),
        )}
      </nav>

      <div className="mt-auto flex flex-col gap-0.5">
        <NavLink to="/settings" onClick={onNavigate} className={({ isActive }) => cx(ITEM, isActive ? ITEM_ACTIVE : ITEM_IDLE)}>
          <Settings size={16} aria-hidden="true" />
          Settings
        </NavLink>
        <div className="flex items-center gap-1 pt-1">
          {session.auth_mode === 'accounts' && session.user ? <UserMenu session={session} onNavigate={onNavigate} /> : null}
          <span className="flex-1" />
          <IconButton
            size="sm"
            label="Keyboard shortcuts"
            icon={<Keyboard size={16} aria-hidden="true" />}
            onClick={onShowShortcuts}
          />
          <IconButton
            size="sm"
            label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            icon={dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            onClick={() => setThemePreference(dark ? 'light' : 'dark')}
          />
        </div>
      </div>
    </div>
  )
}

function UserMenu({ session, onNavigate }: { session: SessionOut; onNavigate: () => void }) {
  const navigate = useNavigate()
  const signOut = useSignOut()
  const toast = useToast()
  const user = session.user
  if (!user) return null
  return (
    <Menu>
      <MenuTrigger
        className={cx(ITEM, ITEM_IDLE, 'min-w-0 px-2')}
        aria-label={`Account: ${user.is_guest ? 'Guest' : user.username}`}
      >
        <CircleUser size={16} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{user.is_guest ? 'Guest' : user.username}</span>
      </MenuTrigger>
      <MenuContent side="top">
        <MenuLabel>{user.is_guest ? 'Guest session' : `Signed in as ${user.username}`}</MenuLabel>
        <MenuItem
          icon={<Settings size={14} aria-hidden="true" />}
          onSelect={() => {
            void navigate('/settings')
            onNavigate()
          }}
        >
          Account and API tokens
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<LogOut size={14} aria-hidden="true" />}
          onSelect={() =>
            signOut.mutate(undefined, {
              onError: (error) => toast({ tone: 'danger', title: 'Could not sign out', description: errorMessage(error) }),
            })
          }
        >
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
