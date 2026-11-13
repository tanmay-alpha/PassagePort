import { FolderX } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { errorMessage } from '@/api/client'
import type { CollectionOut } from '@/api/types'
import { cx } from '@/lib/cx'
import { useRouteCollection } from '@/lib/workspace'

import { buttonClass } from './Button'
import { EmptyState, Notice, Skeleton } from './Feedback'

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8', className)}>{children}</div>
}

export interface PageHeaderProps {
  title: string
  /** Small line above the title, e.g. the workspace name. */
  eyebrow?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ title, eyebrow, description, actions }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 truncate text-[13px] font-medium text-ink-3">{eyebrow}</p> : null}
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function SectionHeading({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <h2 id={id} className={cx('text-sm font-semibold text-ink', className)}>
      {children}
    </h2>
  )
}

/** Resolves the workspace in the URL and renders its loading / missing / error states once. */
export function WorkspaceBoundary({ children }: { children: (collection: CollectionOut) => ReactNode }) {
  const { collection, isPending, isMissing, error } = useRouteCollection()
  if (collection) return children(collection)
  if (isPending) {
    return (
      <Page>
        <div role="status" aria-label="Loading workspace" className="space-y-4">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </Page>
    )
  }
  if (isMissing) {
    return (
      <Page>
        <EmptyState
          icon={<FolderX size={20} aria-hidden="true" />}
          title="Workspace not found"
          description="It may have been deleted, or the link is incorrect."
          action={
            <Link to="/" className={buttonClass('primary')}>
              All workspaces
            </Link>
          }
        />
      </Page>
    )
  }
  return (
    <Page>
      <Notice tone="danger" title="This workspace could not be loaded.">
        {errorMessage(error)}
      </Notice>
    </Page>
  )
}
