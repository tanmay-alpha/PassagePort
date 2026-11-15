import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/Feedback'
import { ToastProvider } from '@/components/ui/Toast'
import { TooltipProvider } from '@/components/ui/Tooltip'

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        // Retry only when the server was unreachable; API errors are answers, not glitches.
        retry: (failureCount, error) => error instanceof ApiError && error.unreachable && failureCount < 2,
      },
      mutations: { retry: false },
    },
  })
}

export function AppProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300} skipDelayDuration={200}>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/** Last line of defence for errors thrown outside the router (providers, boot). */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('PassagePort failed to render', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <EmptyState
          title="PassagePort ran into a problem"
          description="Reloading usually fixes it. Your documents are not affected."
          action={
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      </div>
    )
  }
}
