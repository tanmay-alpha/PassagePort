import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { type ComponentProps, type KeyboardEvent, type ReactNode, useId } from 'react'

import { cx } from '@/lib/cx'

const CONTROL =
  'w-full rounded-md border border-line-strong bg-surface text-sm text-ink placeholder:text-ink-3 ' +
  'transition-colors duration-100 hover:border-ink-3 disabled:opacity-60 ' +
  'aria-[invalid=true]:border-danger focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent'

export function Input({ className, type = 'text', ...rest }: ComponentProps<'input'>) {
  return <input type={type} className={cx(CONTROL, 'h-9 px-3', className)} {...rest} />
}

export function Textarea({ className, rows = 3, ...rest }: ComponentProps<'textarea'>) {
  return <textarea rows={rows} className={cx(CONTROL, 'resize-y px-3 py-2 leading-relaxed', className)} {...rest} />
}

/** Native select: right for long option lists (outlines with hundreds of pages). */
export function NativeSelect({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <span className={cx('relative inline-flex', className)}>
      <select className={cx(CONTROL, 'h-9 appearance-none truncate py-0 pr-8 pl-3')} {...rest}>
        {children}
      </select>
      <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-3" />
    </span>
  )
}

export interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  optional?: boolean
  className?: string
  /** Receives the ids to wire onto the control. */
  children: (control: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': true | undefined }) => ReactNode
}

/** Label + control + hint/error, with the ARIA wiring done once. */
export function Field({ label, hint, error, optional, className, children }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
        {optional ? <span className="ml-1 font-normal text-ink-3">(optional)</span> : null}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error ? (
        <p id={errorId} role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-[13px] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export interface SelectProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: ReadonlyArray<SelectOption<T>>
  'aria-label'?: string
  id?: string
  className?: string
  disabled?: boolean
}

export function Select<T extends string>({ value, onValueChange, options, className, id, disabled, ...aria }: SelectProps<T>) {
  return (
    <RadixSelect.Root value={value} onValueChange={(next) => onValueChange(next as T)} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        aria-label={aria['aria-label']}
        className={cx(CONTROL, 'inline-flex h-9 items-center justify-between gap-2 px-3 text-left', className)}
      >
        <RadixSelect.Value />
        <RadixSelect.Icon>
          <ChevronDown size={14} className="text-ink-3" aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-[60] max-h-72 min-w-[var(--radix-select-trigger-width)] animate-pop-in overflow-hidden rounded-md border border-line bg-surface shadow-pop"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                className="flex h-8 cursor-default items-center gap-2 rounded px-2 text-sm text-ink outline-none select-none data-[highlighted]:bg-subtle"
              >
                <span className="flex size-4 items-center justify-center">
                  <RadixSelect.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                  </RadixSelect.ItemIndicator>
                </span>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}

export interface SegmentedControlProps<T extends string> {
  label: string
  value: T
  onValueChange: (value: T) => void
  options: ReadonlyArray<SelectOption<T> & { hint?: string }>
  className?: string
}

/** Single-choice toggle group with radio semantics and arrow-key movement. */
export function SegmentedControl<T extends string>({ label, value, onValueChange, options, className }: SegmentedControlProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const index = options.findIndex((option) => option.value === value)
    const next = options[(index + step + options.length) % options.length]
    onValueChange(next.value)
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('inline-flex h-9 items-center gap-0.5 rounded-md border border-line bg-subtle p-0.5', className)}
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            tabIndex={checked ? 0 : -1}
            title={option.hint}
            onClick={() => onValueChange(option.value)}
            onKeyDown={onKeyDown}
            className={cx(
              'h-full rounded px-3 text-[13px] font-medium transition-colors duration-100',
              checked ? 'bg-surface text-ink shadow-[0_0_0_1px_var(--pp-line)]' : 'text-ink-2 hover:text-ink',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export interface SwitchProps extends Omit<ComponentProps<'button'>, 'onChange' | 'role'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function Switch({ checked, onCheckedChange, className, disabled, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-100 disabled:opacity-50',
        checked ? 'border-accent bg-accent' : 'border-line-strong bg-subtle',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cx(
          'block size-3.5 rounded-full transition-transform duration-100',
          checked ? 'translate-x-[18px] bg-on-accent' : 'translate-x-0.5 bg-ink-3',
        )}
      />
    </button>
  )
}
