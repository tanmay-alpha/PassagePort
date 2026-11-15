import type { ComponentProps, ReactNode } from 'react'

import { cx } from '@/lib/cx'

import { Spinner } from './Feedback'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none ' +
  'transition-colors duration-100 disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:pointer-events-none'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-subtle',
  ghost: 'text-ink-2 hover:bg-subtle hover:text-ink',
  danger: 'bg-danger text-on-danger hover:opacity-90',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
}

/** Class string for links that should look like buttons. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string): string {
  return cx(BASE, VARIANTS[variant], SIZES[size], extra)
}

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and blocks repeated activation while a request is in flight. */
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children' | 'aria-label'> {
  /** Accessible name; also shown as the tooltip. */
  label: string
  icon: ReactNode
  size?: ButtonSize
  variant?: 'ghost' | 'secondary'
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
}

export function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'ghost',
  tooltipSide,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={label} side={tooltipSide}>
      <button
        type={type}
        aria-label={label}
        className={cx(BASE, VARIANTS[variant], size === 'sm' ? 'size-8' : 'size-9', className)}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  )
}
