import type { Passage } from '@/api/types'
import { cx } from '@/lib/cx'
import { locatorNoun, plural } from '@/lib/format'

export interface HitStripProps {
  documentId: string
  pageCount: number
  /** The whole result list; only this document's passages are drawn. */
  related: readonly Passage[]
  currentId: string | null
  onSelect: (passage: Passage) => void
}

/** 24px: the minimum target size (WCAG 2.5.8) so ticks stay tappable on touch screens. */
const TICK = 24
const GAP = 2

/**
 * Where the other results of the same query fall in this document: one numbered tick per
 * passage, placed by page. Ticks on the same page sit side by side.
 */
export function HitStrip({ documentId, pageCount, related, currentId, onSelect }: HitStripProps) {
  const hits = related
    .map((passage, index) => ({ passage, number: index + 1 }))
    .filter(({ passage }) => passage.document_id === documentId)
  if (hits.length < 2 || pageCount < 1) return null

  const byPage = new Map<number, typeof hits>()
  for (const hit of hits) {
    const page = Math.min(Math.max(hit.passage.page_number, 1), pageCount)
    byPage.set(page, [...(byPage.get(page) ?? []), hit])
  }
  const noun = locatorNoun(hits[0].passage.locator_kind)

  return (
    <div className="mt-2" data-testid="hit-strip">
      <p className="mb-1 flex items-baseline justify-between gap-2 text-[11px] text-ink-3">
        <span>{`${plural(hits.length, 'result')} in this document`}</span>
        <span className="tabular-nums">{`${pageCount} ${locatorNoun(hits[0].passage.locator_kind, pageCount)}`}</span>
      </p>
      <ol aria-label="Results in this document" className="relative h-8 rounded-md bg-subtle">
        {[...byPage.entries()].flatMap(([page, group]) =>
          group.map(({ passage, number }, index) => {
            const current = passage.chunk_id === currentId
            const offset = (index - (group.length - 1) / 2) * (TICK + GAP)
            return (
              <li
                key={passage.chunk_id}
                className="absolute top-1/2"
                style={{ left: `calc(${((page - 0.5) / pageCount) * 100}% + ${offset}px)`, transform: 'translate(-50%, -50%)' }}
              >
                <button
                  type="button"
                  aria-label={`Result ${number}, ${passage.page_label}${current ? ', shown' : ''}`}
                  aria-current={current ? 'true' : undefined}
                  title={`Result ${number} · ${noun} ${passage.page_number}`}
                  onClick={() => onSelect(passage)}
                  className={cx(
                    'flex h-6 min-w-6 items-center justify-center rounded px-0.5 text-[11px] font-semibold tabular-nums transition-transform duration-100 hover:scale-110',
                    current ? 'bg-accent text-on-accent' : 'bg-mark text-ink shadow-[inset_0_-2px_0_var(--pp-mark-strong)]',
                  )}
                >
                  {number}
                </button>
              </li>
            )
          }),
        )}
      </ol>
    </div>
  )
}
