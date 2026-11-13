import { useState } from 'react'

import { useChunk } from '@/api/queries'
import type { Passage } from '@/api/types'

export interface SelectedPassage {
  /** The passage to preview, or null when nothing is selected (or it is still resolving). */
  selected: Passage | null
  /** The URL names a passage the server no longer has. */
  missing: boolean
}

/**
 * Resolves the `hit` URL parameter to a passage: from the results on screen when possible,
 * otherwise from the server (a shared link may point at a passage outside the current list).
 * `settled` delays the server lookup until the screen's own request has finished.
 */
export function useSelectedPassage(
  hitId: string | null,
  candidates: readonly Passage[] | undefined,
  settled: boolean,
): SelectedPassage {
  const local = hitId ? candidates?.find((passage) => passage.chunk_id === hitId) : undefined
  const linked = useChunk(hitId && !local && settled ? hitId : null)
  return {
    selected: local ?? (hitId ? linked.data : undefined) ?? null,
    missing: hitId !== null && !local && linked.isError,
  }
}

/**
 * An editable copy of a URL parameter. The draft follows the URL when it changes from outside
 * (back/forward, links) and is otherwise only committed by the screen's submit handler.
 */
export function useDraft(committed: string): [string, (value: string) => void] {
  const [draft, setDraft] = useState(committed)
  const [synced, setSynced] = useState(committed)
  if (committed !== synced) {
    setSynced(committed)
    setDraft(committed)
  }
  return [draft, setDraft]
}
