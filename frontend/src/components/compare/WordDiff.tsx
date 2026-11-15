import { ArrowRight } from 'lucide-react'
import { useMemo } from 'react'

import { cx } from '@/lib/cx'
import { diffStats, diffWords } from '@/lib/diff'
import { plural } from '@/lib/format'

export interface WordDiffProps {
  fromTitle: string
  fromText: string
  toTitle: string
  toText: string
}

/**
 * Inline word-level diff of two aligned passages, computed here from their text. Removed and
 * added words differ by strike-through vs underline (not only colour) and are announced as
 * such; changed numbers are emphasised.
 */
export function WordDiff({ fromTitle, fromText, toTitle, toText }: WordDiffProps) {
  const parts = useMemo(() => diffWords(fromText, toText), [fromText, toText])
  const stats = useMemo(() => (parts ? diffStats(parts) : null), [parts])

  return (
    <figure className="min-w-0" data-testid="word-diff">
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className="max-w-[45%] truncate font-medium text-ink" title={fromTitle}>
          {fromTitle}
        </span>
        <ArrowRight size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
        <span className="sr-only">compared with</span>
        <span className="max-w-[45%] truncate font-medium text-ink" title={toTitle}>
          {toTitle}
        </span>
        {stats ? (
          <span className="text-xs text-ink-3">
            {[
              stats.removed > 0 ? `${plural(stats.removed, 'word')} removed` : null,
              stats.added > 0 ? `${plural(stats.added, 'word')} added` : null,
              stats.numeric > 0 ? `${plural(stats.numeric, 'number change', 'number changes')}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'No word changes'}
          </span>
        ) : null}
      </figcaption>
      {parts === null ? (
        <p className="mt-2 text-[13px] text-ink-3">These passages are too long to compare word by word.</p>
      ) : (
        <p className="pp-passage mt-2 rounded-lg border border-line bg-surface px-3.5 py-3 text-[0.92rem] whitespace-pre-line text-ink">
          {parts.map((part, index) =>
            part.kind === 'equal' ? (
              <span key={index}>{part.text}</span>
            ) : part.kind === 'removed' ? (
              <del key={index} className={cx('pp-diff-removed', part.numeric && 'pp-diff-number')}>
                <span className="sr-only">{part.numeric ? '[removed number: ' : '[removed: '}</span>
                {part.text}
                <span className="sr-only">]</span>
              </del>
            ) : (
              <ins key={index} className={cx('pp-diff-added', part.numeric && 'pp-diff-number')}>
                <span className="sr-only">{part.numeric ? '[added number: ' : '[added: '}</span>
                {part.text}
                <span className="sr-only">]</span>
              </ins>
            ),
          )}
        </p>
      )}
    </figure>
  )
}

/** Key for the diff styles, shown once per comparison. */
export function DiffLegend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3" aria-hidden="true">
      <span>
        <del className="pp-diff-removed">removed</del>
      </span>
      <span>
        <ins className="pp-diff-added">added</ins>
      </span>
      <span>
        <ins className="pp-diff-added pp-diff-number">42</ins> changed number
      </span>
    </p>
  )
}
