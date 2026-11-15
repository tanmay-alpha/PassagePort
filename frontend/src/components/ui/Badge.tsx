import type { ReactNode } from 'react'

import type { DocumentOut } from '@/api/types'
import { cx } from '@/lib/cx'

import { Spinner } from './Feedback'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-subtle text-ink-2',
  accent: 'border-accent/25 bg-accent-soft text-accent',
  success: 'border-success/25 bg-success-soft text-success',
  warning: 'border-warning/30 bg-warning-soft text-warning',
  danger: 'border-danger/30 bg-danger-soft text-danger',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center gap-1 rounded border px-1.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export type DocumentState = 'uploaded' | 'processing' | 'indexed' | 'failed' | 'stale'

/** `stale` is an indexed document whose index no longer matches the server's models. */
export function documentState(document: Pick<DocumentOut, 'status' | 'stale'>): DocumentState {
  return document.status === 'indexed' && document.stale ? 'stale' : document.status
}

export const DOCUMENT_STATE_LABELS: Record<DocumentState, string> = {
  uploaded: 'Queued',
  processing: 'Indexing',
  indexed: 'Indexed',
  failed: 'Failed',
  stale: 'Needs re-index',
}

const STATE_TONES: Record<DocumentState, BadgeTone> = {
  uploaded: 'neutral',
  processing: 'accent',
  indexed: 'success',
  failed: 'danger',
  stale: 'warning',
}

export function StatusBadge({ document }: { document: Pick<DocumentOut, 'status' | 'stale'> }) {
  const state = documentState(document)
  return (
    <Badge tone={STATE_TONES[state]}>
      {state === 'processing' ? <Spinner size={10} /> : null}
      {DOCUMENT_STATE_LABELS[state]}
    </Badge>
  )
}
