import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { cx } from '@/lib/cx'

export function Spinner({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      className={cx('inline-flex items-center gap-2', className)}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
    >
      <svg
        className="animate-spin text-current motion-reduce:animate-none"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label ? <span>{label}</span> : null}
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('animate-pulse rounded-md bg-subtle motion-reduce:animate-none', className)} />
}

/** Placeholder rows announced once to assistive tech instead of per skeleton. */
export function SkeletonList({ rows = 3, label, className }: { rows?: number; label: string; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cx('space-y-3', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  )
}

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center px-6 py-12 text-center', className)}>
      {icon ? (
        <div className="mb-4 flex size-11 items-center justify-center rounded-lg border border-line bg-surface text-ink-3">
          {icon}
        </div>
      ) : null}
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {description ? <div className="mt-1.5 max-w-md text-sm text-ink-2">{description}</div> : null}
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  )
}

export type NoticeTone = 'info' | 'warning' | 'danger'

const NOTICE_STYLES: Record<NoticeTone, string> = {
  info: 'border-line bg-subtle text-ink-2',
  warning: 'border-warning/30 bg-warning-soft text-warning',
  danger: 'border-danger/30 bg-danger-soft text-danger',
}

const NOTICE_ICONS: Record<NoticeTone, typeof Info> = { info: Info, warning: TriangleAlert, danger: CircleAlert }

export interface NoticeProps extends Omit<ComponentProps<'div'>, 'title'> {
  tone?: NoticeTone
  title?: ReactNode
  action?: ReactNode
}

/** Inline message. `danger` is announced immediately; other tones politely. */
export function Notice({ tone = 'info', title, action, children, className, role, ...rest }: NoticeProps) {
  const Icon = NOTICE_ICONS[tone]
  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={cx('flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm', NOTICE_STYLES[tone], className)}
      {...rest}
    >
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cx(title ? 'mt-0.5' : undefined, 'text-ink')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface px-1 font-sans text-[11px] font-medium text-ink-2">
      {children}
    </kbd>
  )
}

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cx('rounded-lg border border-line bg-surface', className)} {...rest} />
}

/** Determinate when `value` is given (0..1), otherwise an honest indeterminate bar. */
export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const percent = value === null ? undefined : Math.round(Math.min(Math.max(value, 0), 1) * 100)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-subtle"
    >
      {percent === undefined ? (
        <div className="h-full w-2/5 animate-indeterminate rounded-full bg-accent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-50" />
      ) : (
        <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
      )}
    </div>
  )
}
