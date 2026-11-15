import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { isRouteErrorResponse, Link, Outlet, type RouteObject, useRouteError } from 'react-router'

import { setUnauthorizedHandler } from '@/api/client'
import { keys } from '@/api/queries'
import { AppShell } from '@/components/shell/AppShell'
import { Button, buttonClass } from '@/components/ui/Button'
import { EmptyState, Spinner } from '@/components/ui/Feedback'
import { useDocumentTitle } from '@/lib/hooks'

function Root() {
  const queryClient = useQueryClient()
  useEffect(() => {
    // A 401 means the session ended. Re-reading it lets the shell redirect to /login in
    // accounts mode; in local mode the session stays valid and nothing happens.
    setUnauthorizedHandler(() => void queryClient.invalidateQueries({ queryKey: keys.session }))
    return () => setUnauthorizedHandler(null)
  }, [queryClient])
  return <Outlet />
}

function RouteFallback() {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center text-ink-2">
      <Spinner label="Loading…" />
    </div>
  )
}

function NotFound() {
  useDocumentTitle('Page not found')
  return (
    <EmptyState
      className="min-h-[60dvh] justify-center"
      title="Page not found"
      description="There is nothing at this address. It may have been moved or deleted."
      action={
        <Link to="/" className={buttonClass('primary')}>
          Go to workspaces
        </Link>
      }
    />
  )
}

function RouteError() {
  const error = useRouteError()
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />
  // Typically a code-split chunk that failed to download, or a rendering bug.
  console.error('Route failed to render', error)
  return (
    <EmptyState
      className="min-h-[60dvh] justify-center"
      title="This screen could not be displayed"
      description="Something went wrong while loading or rendering it. Reloading usually fixes it."
      action={
        <>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Link to="/" className={buttonClass('secondary')}>
            Go to workspaces
          </Link>
        </>
      }
    />
  )
}

/** Every screen is its own chunk; pdf.js is split further inside the viewer. */
export const routes: RouteObject[] = [
  {
    Component: Root,
    ErrorBoundary: RouteError,
    HydrateFallback: RouteFallback,
    children: [
      { path: 'login', lazy: () => import('./pages/LoginPage') },
      {
        Component: AppShell,
        children: [
          {
            // Keeps the shell on screen when a single page fails.
            ErrorBoundary: RouteError,
            children: [
              { index: true, lazy: () => import('./pages/HomePage') },
              { path: 'c/:collectionId', lazy: () => import('./pages/LibraryPage') },
              { path: 'c/:collectionId/search', lazy: () => import('./pages/SearchPage') },
              { path: 'c/:collectionId/ask', lazy: () => import('./pages/AskPage') },
              { path: 'c/:collectionId/compare', lazy: () => import('./pages/ComparePage') },
              { path: 'c/:collectionId/lab', lazy: () => import('./pages/LabPage') },
              { path: 'd/:documentId', lazy: () => import('./pages/ViewerPage') },
              { path: 'settings', lazy: () => import('./pages/SettingsPage') },
              { path: '*', Component: NotFound },
            ],
          },
        ],
      },
    ],
  },
]
