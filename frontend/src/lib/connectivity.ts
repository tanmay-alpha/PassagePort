import { useSyncExternalStore } from 'react'

/**
 * Tracks whether the last API exchange reached the server. The fetch client reports every
 * outcome here, so the banner reflects real request results rather than `navigator.onLine`
 * alone (which stays true when only the backend is down).
 */
let reachable = true
const listeners = new Set<() => void>()

export function reportReachability(next: boolean): void {
  if (reachable === next) return
  reachable = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useServerReachable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => reachable,
    () => true,
  )
}
