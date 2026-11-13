import type { KeyboardEvent, ReactNode } from 'react'

import type { Passage } from '@/api/types'
import { cx } from '@/lib/cx'

import { PassageSource, PassageText } from './PassageText'

export interface PassageCardProps {
  passage: Passage
  /** Matched query terms to mark in the text. */
  terms?: readonly string[]
  /** Short label in front of the source: a rank or a citation number. */
  marker?: ReactNode
  /** True while this passage is the one shown in the preview. */
  selected: boolean
  onOpen: () => void
  /** Rendered below the passage, outside the button (e.g. the retrieval line). */
  children?: ReactNode
  /** DOM id of the button, so citation chips can move focus to it. */
  id?: string
  /** Identifies the card inside a `data-passage-list` container for arrow-key movement. */
  navKey?: string
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  clampLines?: boolean
  className?: string
}

/** A passage that opens in the document viewer. The whole passage is one button. */
/**
 * Arrow/Home/End movement between the passage buttons of the enclosing `data-passage-list`.
 * Returns the newly focused button, or null when the key was not a movement key.
 */
export function movePassageFocus(event: KeyboardEvent<HTMLButtonElement>): HTMLButtonElement | null {
  const list = event.currentTarget.closest('[data-passage-list]')
  if (!list) return null
  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-passage]'))
  const index = buttons.indexOf(event.currentTarget)
  let target: number
  if (event.key === 'ArrowDown') target = index + 1
  else if (event.key === 'ArrowUp') target = index - 1
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = buttons.length - 1
  else return null
  const next = buttons[target]
  if (!next || next === event.currentTarget) return null
  event.preventDefault()
  next.focus()
  return next
}

export function PassageCard({
  passage,
  terms,
  marker,
  selected,
  onOpen,
  children,
  id,
  navKey,
  onKeyDown,
  clampLines = true,
  className,
}: PassageCardProps) {
  return (
    <div
      className={cx(
        'rounded-lg border bg-surface transition-colors duration-100',
        selected ? 'border-accent shadow-[0_0_0_1px_var(--pp-accent)]' : 'border-line hover:border-line-strong',
        className,
      )}
    >
      <button
        type="button"
        id={id}
        data-passage={navKey}
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        className="block w-full rounded-lg px-4 pt-3 pb-3 text-left"
      >
        <span className="flex items-center gap-2">
          {marker ? (
            <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-subtle px-1 text-xs font-semibold text-ink-2 tabular-nums">
              {marker}
            </span>
          ) : null}
          <PassageSource passage={passage} />
        </span>
        <PassageText text={passage.text} terms={terms} className={cx('mt-2', clampLines && 'line-clamp-6')} />
        <span className="sr-only">Open in document viewer</span>
      </button>
      {children ? <div className="px-4 pb-3">{children}</div> : null}
    </div>
  )
}

export interface CitationChipProps {
  refNumber: number
  onActivate: () => void
  active?: boolean
}

/** Inline numbered citation; activating it focuses the evidence and opens it in the viewer. */
export function CitationChip({ refNumber, onActivate, active = false }: CitationChipProps) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={`Citation ${refNumber}: show the cited passage`}
      className={cx(
        'mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded px-1 align-[0.1em] font-sans text-[11px] font-semibold tabular-nums transition-colors duration-100',
        active ? 'bg-accent text-on-accent' : 'bg-accent-soft text-accent hover:bg-accent hover:text-on-accent',
      )}
    >
      {refNumber}
    </button>
  )
}
