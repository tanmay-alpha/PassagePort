import * as Popover from '@radix-ui/react-popover'
import { Copy, FileText, Maximize2 } from 'lucide-react'
import { type PointerEvent, useEffect, useId, useRef, useState } from 'react'

import type { Evidence } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { copyPlainText, excerpt, formatCitation, locatorLabel } from '@/lib/citation'
import { cx } from '@/lib/cx'

import { PassageText } from './PassageText'

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 180

export interface CitationChipProps {
  refNumber: number
  evidence: Evidence
  /** Activating the chip: focus the evidence and open it in the document preview. */
  onActivate: () => void
  /** The cited passage is the one shown in the preview. */
  active?: boolean
  /** Another element (a source card) points at this citation. */
  linked?: boolean
  onLinkChange?: (refNumber: number | null) => void
}

/**
 * Inline numbered citation. Pointing at it or focusing it with the keyboard previews the cited
 * excerpt with its page; activating it opens the passage in the document viewer.
 */
export function CitationChip({ refNumber, evidence, onActivate, active = false, linked = false, onLinkChange }: CitationChipProps) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  // Focus that follows a press (mouse or tap) is not keyboard focus: the click opens the
  // source right away, so no preview is shown for it.
  const pressed = useRef(false)
  const chip = useRef<HTMLButtonElement>(null)
  const excerptId = useId()
  const toast = useToast()
  useEffect(() => () => window.clearTimeout(timer.current), [])

  function schedule(next: boolean, delay: number) {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(next), delay)
  }

  function onPointerEnter(event: PointerEvent) {
    onLinkChange?.(refNumber)
    if (event.pointerType === 'mouse') schedule(true, OPEN_DELAY_MS)
  }

  function onPointerLeave() {
    onLinkChange?.(null)
    schedule(false, CLOSE_DELAY_MS)
  }

  function onFocus() {
    onLinkChange?.(refNumber)
    if (!pressed.current) {
      window.clearTimeout(timer.current)
      setOpen(true)
    }
    pressed.current = false
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <button
          ref={chip}
          type="button"
          onClick={() => {
            setOpen(false)
            onActivate()
          }}
          onPointerDown={() => {
            pressed.current = true
          }}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onFocus={onFocus}
          onBlur={() => {
            onLinkChange?.(null)
            schedule(false, CLOSE_DELAY_MS)
          }}
          aria-label={`Citation ${refNumber}: show the cited passage`}
          aria-describedby={open ? excerptId : undefined}
          data-ref={refNumber}
          className={cx(
            'mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded px-1 align-[0.1em] font-sans text-[11px] font-semibold tabular-nums transition-[background-color,color,box-shadow] duration-100',
            active ? 'bg-accent text-on-accent' : 'bg-accent-soft text-accent hover:bg-accent hover:text-on-accent',
            linked && !active && 'shadow-[0_0_0_2px_var(--pp-accent)]',
          )}
        >
          {refNumber}
        </button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          // Focus stays on the chip: the preview is supplementary, Enter still opens the source.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // The chip is an anchor, not a Radix trigger, so the layer would treat the very focus
          // that opened it (still dispatching when the layer mounts) as focus moving outside.
          onInteractOutside={(event) => {
            if (event.target instanceof Node && chip.current?.contains(event.target)) event.preventDefault()
          }}
          onPointerEnter={() => window.clearTimeout(timer.current)}
          onPointerLeave={() => schedule(false, CLOSE_DELAY_MS)}
          aria-label={`Citation ${refNumber}`}
          className="z-[70] w-[min(22rem,calc(100vw-1.5rem))] animate-pop-in rounded-xl border border-line bg-surface p-3.5 text-ink shadow-pop"
          data-testid="citation-popover"
        >
          <p className="flex min-w-0 items-center gap-1.5 text-xs">
            <span className="inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded bg-accent text-[11px] font-semibold text-on-accent tabular-nums">
              {refNumber}
            </span>
            <FileText size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
            <span className="truncate font-medium text-ink">{evidence.document_title}</span>
            <span className="shrink-0 text-ink-3">{locatorLabel(evidence)}</span>
          </p>
          <div id={excerptId}>
            <PassageText text={evidence.text} terms={evidence.matched_terms} clamped className="mt-2 text-[0.9rem] leading-relaxed" />
          </div>
          <div className="mt-3 flex items-center justify-end gap-1.5 border-t border-line pt-2.5">
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={13} aria-hidden="true" />}
              onClick={() =>
                copyPlainText(formatCitation(evidence)).then(
                  () => toast({ tone: 'success', title: 'Citation copied', description: `${evidence.document_title}, ${locatorLabel(evidence)}` }),
                  (error: unknown) =>
                    toast({ tone: 'danger', title: 'Could not copy', description: error instanceof Error ? error.message : undefined }),
                )
              }
            >
              Copy citation
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Maximize2 size={13} aria-hidden="true" />}
              onClick={() => {
                setOpen(false)
                onActivate()
              }}
            >
              Open in document
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export interface SourceCardsProps {
  evidence: Evidence[]
  /** Only the citations the answer actually uses, in order; others stay in the evidence list. */
  cited: number[]
  selectedId: string | null
  linkedRef: number | null
  onLinkChange: (refNumber: number | null) => void
  onOpen: (evidence: Evidence) => void
}

/** The sources an answer relies on, numbered like its inline citations, above the answer. */
export function SourceCards({ evidence, cited, selectedId, linkedRef, onLinkChange, onOpen }: SourceCardsProps) {
  const byRef = new Map(evidence.map((item) => [item.ref, item]))
  const sources = cited.map((refNumber) => byRef.get(refNumber)).filter((item): item is Evidence => item !== undefined)
  if (sources.length === 0) return null
  return (
    <section aria-labelledby="sources-heading" className="mb-3">
      <h2 id="sources-heading" className="mb-2 text-xs font-medium tracking-[0.06em] text-ink-3 uppercase">
        Sources
      </h2>
      <ol className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
        {sources.map((source) => {
          const selected = source.chunk_id === selectedId
          const linked = linkedRef === source.ref
          const descriptionId = `source-${source.ref}-excerpt`
          return (
            <li key={source.chunk_id} className="w-56 shrink-0 snap-start sm:w-60">
              <button
                type="button"
                aria-label={`Source ${source.ref}: ${source.document_title}, ${source.page_label}`}
                aria-describedby={descriptionId}
                aria-current={selected ? 'true' : undefined}
                data-source={source.ref}
                onClick={() => onOpen(source)}
                onPointerEnter={() => onLinkChange(source.ref)}
                onPointerLeave={() => onLinkChange(null)}
                onFocus={() => onLinkChange(source.ref)}
                onBlur={() => onLinkChange(null)}
                className={cx(
                  'flex h-full w-full flex-col rounded-lg border bg-surface p-2.5 text-left transition-[border-color,box-shadow] duration-100',
                  selected
                    ? 'border-accent shadow-[0_0_0_1px_var(--pp-accent)]'
                    : linked
                      ? 'border-accent/60'
                      : 'border-line hover:border-line-strong',
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-xs">
                  <span className="inline-flex h-[1.15rem] min-w-[1.15rem] shrink-0 items-center justify-center rounded bg-accent-soft px-1 text-[11px] font-semibold text-accent tabular-nums">
                    {source.ref}
                  </span>
                  <span className="truncate font-medium text-ink">{source.document_title}</span>
                </span>
                <span id={descriptionId} className="pp-passage mt-1.5 line-clamp-2 text-[0.82rem] leading-snug text-ink-2">
                  {excerpt(source.text, 140)}
                </span>
                <span className="mt-auto pt-1.5 text-[11px] text-ink-3">{source.page_label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
