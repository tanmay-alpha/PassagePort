import { Columns2, FlaskConical, type LucideIcon, MessageSquareText, Search } from 'lucide-react'
import { Link } from 'react-router'

import type { DocumentOut } from '@/api/types'
import { Spinner } from '@/components/ui/Feedback'
import { cx } from '@/lib/cx'
import { SAMPLE_SUGGESTIONS, sampleDocuments, type SuggestionKind, suggestionPath } from '@/lib/samples'

const KINDS: Record<SuggestionKind, { verb: string; icon: LucideIcon }> = {
  search: { verb: 'Search', icon: Search },
  ask: { verb: 'Ask', icon: MessageSquareText },
  compare: { verb: 'Compare', icon: Columns2 },
  lab: { verb: 'Search Lab', icon: FlaskConical },
}

const CHIP =
  'inline-flex h-9 max-w-full items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors duration-100'

/**
 * First queries for a workspace holding the bundled samples. Each one is a real link into
 * Search, Ask, Compare or the Search Lab, enabled once the documents it needs are indexed.
 */
export function SampleSuggestions({ collectionId, documents }: { collectionId: string; documents: readonly DocumentOut[] }) {
  const samples = sampleDocuments(documents)
  if (samples.size === 0) return null
  const suggestions = SAMPLE_SUGGESTIONS.filter((suggestion) => suggestion.needs.every((name) => samples.has(name)))
  if (suggestions.length === 0) return null
  const waiting = suggestions.some((suggestion) => suggestionPath(collectionId, suggestion, samples) === null)

  return (
    <section aria-labelledby="suggestions-heading" className="mb-6 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="suggestions-heading" className="text-sm font-semibold text-ink">
          Try a first query
        </h2>
        <p className="text-xs text-ink-3" aria-live="polite">
          {waiting ? (
            <Spinner size={11} label="Some suggestions unlock when indexing finishes" />
          ) : (
            'Every result links to the exact page it came from.'
          )}
        </p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {suggestions.map((suggestion) => {
          const { verb, icon: Icon } = KINDS[suggestion.kind]
          const path = suggestionPath(collectionId, suggestion, samples)
          const content = (
            <>
              <Icon size={14} className="shrink-0" aria-hidden="true" />
              <span className="shrink-0 font-medium">{verb}</span>
              <span className="truncate text-ink-2">{suggestion.label}</span>
            </>
          )
          return (
            <li key={suggestion.label} className="max-w-full">
              {path ? (
                <Link to={path} className={cx(CHIP, 'border-line bg-bg text-ink hover:border-accent hover:bg-accent-soft hover:text-accent')}>
                  {content}
                </Link>
              ) : (
                <span aria-disabled="true" title="Available once the documents it needs are indexed" className={cx(CHIP, 'border-dashed border-line text-ink-3 opacity-70')}>
                  {content}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
