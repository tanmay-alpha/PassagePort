import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

export type ParamChanges = Record<string, string | null>
export type PatchParams = (changes: ParamChanges, options?: { replace?: boolean }) => void

/**
 * URL query parameters as screen state. `patch` merges changes (null or '' removes a key);
 * pushing keeps the back button meaningful, `replace` is for incidental changes.
 */
export function useUrlParams(): [URLSearchParams, PatchParams] {
  const [params, setParams] = useSearchParams()
  const patch = useCallback<PatchParams>(
    (changes, options) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === '') next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: options?.replace ?? false },
      )
    },
    [setParams],
  )
  return [params, patch]
}
