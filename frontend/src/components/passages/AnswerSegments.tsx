import type { AnswerSegment, Evidence } from '@/api/types'
import { Badge } from '@/components/ui/Badge'
import { cx } from '@/lib/cx'

import { CitationChip } from './PassageCard'

/** DOM id of the evidence card for citation `[refNumber]`; chips move focus to it. */
export function evidenceElementId(refNumber: number): string {
  return `evidence-${refNumber}`
}

export interface AnswerSegmentsProps {
  segments: AnswerSegment[]
  extractive: boolean
  byRef: Map<number, Evidence>
  selectedId: string | null
  onCite: (evidence: Evidence) => void
}

/**
 * Answer text. Segments are rendered as plain text nodes — never as HTML or Markdown — so
 * nothing a model or a document contains can inject markup.
 */
export function AnswerSegments({ segments, extractive, byRef, selectedId, onCite }: AnswerSegmentsProps) {
  const Wrapper = extractive ? 'ul' : 'p'
  const Item = extractive ? 'li' : 'span'
  return (
    <Wrapper
      data-testid="answer-text"
      className={cx(
        'mt-4 text-ink',
        extractive ? 'pp-passage space-y-2.5' : 'text-[15px] leading-relaxed whitespace-pre-wrap',
      )}
    >
      {segments.map((segment, index) => (
        <Item
          key={index}
          data-supported={segment.supported}
          className={cx(
            extractive && 'block border-l-2 border-line-strong pl-3',
            !segment.supported && 'underline decoration-warning decoration-wavy decoration-1 underline-offset-4',
          )}
        >
          {segment.text}
          {segment.citations.map((refNumber) => {
            const evidence = byRef.get(refNumber)
            return evidence ? (
              <CitationChip
                key={refNumber}
                refNumber={refNumber}
                active={evidence.chunk_id === selectedId}
                onActivate={() => onCite(evidence)}
              />
            ) : null
          })}
          {segment.supported ? null : (
            <Badge tone="warning" className="mx-1 align-[0.1em] font-sans no-underline">
              No citation
            </Badge>
          )}
          {extractive ? null : ' '}
        </Item>
      ))}
    </Wrapper>
  )
}
