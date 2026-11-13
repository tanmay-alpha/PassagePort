import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from 'react'

import { cx } from '@/lib/cx'
import { readStored, writeStored } from '@/lib/hooks'

export interface SplitPaneProps {
  primary: ReactNode
  /** When null the primary pane takes the full width (and stays mounted). */
  secondary: ReactNode | null
  /** Share of the width given to `primary`, 0..1. */
  defaultRatio?: number
  minRatio?: number
  maxRatio?: number
  /** localStorage key under which the chosen ratio is remembered. */
  storageKey?: string
  primaryLabel: string
  secondaryLabel: string
  className?: string
}

const KEY_STEP = 0.02

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Two side-by-side panes with a draggable, keyboard-operable divider. */
export function SplitPane({
  primary,
  secondary,
  defaultRatio = 0.5,
  minRatio = 0.25,
  maxRatio = 0.75,
  storageKey,
  primaryLabel,
  secondaryLabel,
  className,
}: SplitPaneProps) {
  const container = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => {
    const stored = storageKey ? Number.parseFloat(readStored(storageKey) ?? '') : Number.NaN
    return clamp(Number.isFinite(stored) ? stored : defaultRatio, minRatio, maxRatio)
  })
  const [dragging, setDragging] = useState(false)

  function commit(next: number) {
    const clamped = clamp(next, minRatio, maxRatio)
    setRatio(clamped)
    if (storageKey) writeStored(storageKey, clamped.toFixed(3))
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging || !container.current) return
    const bounds = container.current.getBoundingClientRect()
    if (bounds.width > 0) commit((event.clientX - bounds.left) / bounds.width)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') commit(ratio - KEY_STEP)
    else if (event.key === 'ArrowRight') commit(ratio + KEY_STEP)
    else if (event.key === 'Home') commit(minRatio)
    else if (event.key === 'End') commit(maxRatio)
    else return
    event.preventDefault()
  }

  return (
    <div ref={container} className={cx('flex h-full min-h-0 w-full', dragging && 'cursor-col-resize select-none', className)}>
      <section
        aria-label={primaryLabel}
        className="min-w-0 overflow-y-auto"
        style={{ width: secondary === null ? '100%' : `${ratio * 100}%` }}
      >
        {primary}
      </section>
      {secondary === null ? null : (
        <>
          {/* A focusable separator with a value is the ARIA "window splitter" widget. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panes"
            aria-valuemin={Math.round(minRatio * 100)}
            aria-valuemax={Math.round(maxRatio * 100)}
            aria-valuenow={Math.round(ratio * 100)}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              setDragging(true)
            }}
            onPointerMove={onPointerMove}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            className={cx(
              'group relative z-10 w-px shrink-0 cursor-col-resize bg-line outline-none',
              'before:absolute before:inset-y-0 before:-left-1.5 before:w-3',
              'after:absolute after:inset-y-0 after:-left-px after:w-[3px] after:transition-colors after:duration-100',
              'hover:after:bg-accent focus-visible:after:bg-accent',
              dragging && 'after:bg-accent',
            )}
          />
          <section aria-label={secondaryLabel} className="min-w-0 flex-1 overflow-hidden">
            {secondary}
          </section>
        </>
      )}
    </div>
  )
}
