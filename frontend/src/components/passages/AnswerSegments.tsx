import { CircleHelp } from 'lucide-react'

import type { AnswerSegment, Evidence } from '@/api/types'
import { cx } from '@/lib/cx'

import { CitationChip } from './Citation'

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
  /** Citation currently pointed at elsewhere (a source card); its sentences are tinted. */
  linkedRef?: number | null
  onLinkChange?: (refNumber: number | null) => void
}

/**
 * Answer text. Segments are rendered as plain text nodes — never as HTML or Markdown — so
 * nothing a model or a document contains can inject markup.
 */
export function AnswerSegments({ segments, extractive, byRef, selectedId, onCite, linkedRef = null, onLinkChange }: AnswerSegmentsProps) {
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
      {segments.map((segment, index) => {
        const linked = linkedRef !== null && segment.citations.includes(linkedRef)
        return (
          <Item
            key={index}
            data-supported={segment.supported}
            data-linked={linked || undefined}
            className={cx(
              'rounded-sm transition-colors duration-150',
              extractive && 'block border-l-2 pl-3',
              extractive && (linked ? 'border-accent' : 'border-line-strong'),
              linked && 'bg-accent-soft/70',
              !segment.supported && 'bg-warning-soft/60 underline decoration-warning decoration-wavy decoration-1 underline-offset-4',
            )}
          >
            {segment.text}
            {segment.citations.map((refNumber) => {
              const evidence = byRef.get(refNumber)
              return evidence ? (
                <CitationChip
                  key={refNumber}
                  refNumber={refNumber}
                  evidence={evidence}
                  active={evidence.chunk_id === selectedId}
                  linked={linkedRef === refNumber}
                  onLinkChange={onLinkChange}
                  onActivate={() => onCite(evidence)}
                />
              ) : null
            })}
            {segment.supported ? null : (
              <span className="mx-1 inline-flex h-5 items-center gap-1 rounded border border-warning/30 bg-warning-soft px-1.5 align-[0.1em] font-sans text-xs font-medium whitespace-nowrap text-warning no-underline">
                <CircleHelp size={12} aria-hidden="true" />
                No citation
              </span>
            )}
            {extractive ? null : ' '}
          </Item>
        )
      })}
    </Wrapper>
  )
}
