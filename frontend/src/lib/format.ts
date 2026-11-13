import type { DocumentKind, LocatorKind } from '@/api/types'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`
}

const numberFormat = new Intl.NumberFormat('en')

export function formatCount(value: number): string {
  return numberFormat.format(value)
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 10) return `${ms.toFixed(0)} ms`
  return `${ms.toFixed(1)} ms`
}

/** Scores are shown as the server computed them, trimmed to a readable precision. */
export function formatScore(score: number, digits = 3): string {
  return Math.abs(score) >= 100 ? score.toFixed(0) : score.toFixed(digits)
}

const dateTimeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })
const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date)
}

/** "5 minutes ago" for the last week, a calendar date after that. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const seconds = Math.round((date.getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return 'just now'
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return relativeFormat.format(Math.round(seconds / 3600), 'hour')
  if (abs < 7 * 86_400) return relativeFormat.format(Math.round(seconds / 86_400), 'day')
  return dateFormat.format(date)
}

const KIND_LABELS: Record<DocumentKind, string> = { pdf: 'PDF', txt: 'Text', md: 'Markdown', docx: 'Word' }

export function kindLabel(kind: DocumentKind): string {
  return KIND_LABELS[kind]
}

export function locatorNoun(kind: LocatorKind, count = 1): string {
  if (kind === 'page') return count === 1 ? 'page' : 'pages'
  return count === 1 ? 'section' : 'sections'
}

/** File extension without the dot, lower-cased; empty when there is none. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot <= 0 ? '' : filename.slice(dot + 1).toLowerCase()
}
