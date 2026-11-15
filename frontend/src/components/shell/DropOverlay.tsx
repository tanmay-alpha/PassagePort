import { FileUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cx } from '@/lib/cx'

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

export interface DropOverlayProps {
  /** Workspace that receives dropped files; null outside a workspace. */
  targetName: string | null
  /** Accepted extensions for the hint, e.g. ".pdf, .md". */
  accepts: string | null
  onDrop: (files: File[]) => void
}

/**
 * Files dragged anywhere over the app show one full-window drop target. Dropping outside a
 * workspace is swallowed (with an explanation) instead of letting the browser navigate away
 * to the file.
 */
export function DropOverlay({ targetName, accepts, onDrop }: DropOverlayProps) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const latestDrop = useRef(onDrop)
  useEffect(() => {
    latestDrop.current = onDrop
  })
  const canDrop = targetName !== null

  useEffect(() => {
    const reset = () => {
      depth.current = 0
      setDragging(false)
    }
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth.current += 1
      setDragging(true)
    }
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth.current = Math.max(depth.current - 1, 0)
      if (depth.current === 0) setDragging(false)
    }
    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none'
    }
    const onDropEvent = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      reset()
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (canDrop && files.length > 0) latestDrop.current(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDropEvent)
    window.addEventListener('dragend', reset)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDropEvent)
      window.removeEventListener('dragend', reset)
    }
  }, [canDrop])

  if (!dragging) return null
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[90] flex animate-fade-in items-center justify-center bg-bg/70 p-4 backdrop-blur-[2px]"
      data-testid="drop-overlay"
    >
      <div
        className={cx(
          'absolute inset-3 rounded-2xl border-2 border-dashed',
          canDrop ? 'border-accent bg-accent-soft/40' : 'border-line-strong',
        )}
        aria-hidden="true"
      />
      <div role="status" className="relative flex max-w-sm flex-col items-center rounded-xl border border-line bg-surface px-8 py-6 text-center shadow-pop">
        <span className={cx('flex size-11 items-center justify-center rounded-full', canDrop ? 'bg-accent text-on-accent' : 'bg-subtle text-ink-3')}>
          <FileUp size={20} aria-hidden="true" />
        </span>
        {canDrop ? (
          <>
            <p className="mt-3 text-base font-semibold text-ink">Drop to add to {targetName}</p>
            {accepts ? <p className="mt-1 text-[13px] text-ink-2">{accepts}</p> : null}
          </>
        ) : (
          <>
            <p className="mt-3 text-base font-semibold text-ink">Open a workspace first</p>
            <p className="mt-1 text-[13px] text-ink-2">Files dropped here are not uploaded. Open or create a workspace, then drop them again.</p>
          </>
        )}
      </div>
    </div>
  )
}
