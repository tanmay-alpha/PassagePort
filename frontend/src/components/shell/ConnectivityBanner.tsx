import { useMutation, useQueryClient } from '@tanstack/react-query'
import { WifiOff } from 'lucide-react'

import { api } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { useServerReachable } from '@/lib/connectivity'

/** Shown after a request failed to reach the server; hides again on the next success. */
export function ConnectivityBanner() {
  const reachable = useServerReachable()
  const queryClient = useQueryClient()
  const retry = useMutation({
    // A successful health check flips the reachability flag; then reload what is on screen.
    mutationFn: () => api<{ status: string }>('/health'),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  if (reachable) return null
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/30 bg-warning-soft px-4 py-2 text-sm text-ink">
      <WifiOff size={16} className="shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        The PassagePort server can’t be reached. Check that it is running and that you are online.
      </p>
      <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>
        Retry
      </Button>
    </div>
  )
}
