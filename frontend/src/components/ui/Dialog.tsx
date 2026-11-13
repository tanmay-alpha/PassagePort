import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { cx } from '@/lib/cx'

import { Button } from './Button'
import { Notice } from './Feedback'

const OVERLAY = 'fixed inset-0 z-50 bg-overlay animate-fade-in'

const CLOSE =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors duration-100 hover:bg-subtle hover:text-ink'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md'
}

/** Modal dialog: focus is trapped inside, Escape and the overlay close it, focus returns to the opener. */
export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'sm' }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY} />
        <RadixDialog.Content
          // Radix warns unless a dialog without a description opts out explicitly.
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cx(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'animate-pop-in rounded-lg border border-line bg-surface shadow-pop',
            size === 'sm' ? 'max-w-md' : 'max-w-xl',
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-5">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-base font-semibold text-ink">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-sm text-ink-2">{description}</RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close className={CLOSE} aria-label="Close dialog">
              <X size={16} aria-hidden="true" />
            </RadixDialog.Close>
          </div>
          {children ? (
            <div className={cx('min-h-0 flex-1 overflow-y-auto px-5 pt-4', !footer && 'pb-5')}>{children}</div>
          ) : null}
          {footer ? <div className="flex flex-wrap justify-end gap-2 p-5">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  onConfirm: () => void
  destructive?: boolean
  pending?: boolean
  error?: string | null
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = false,
  pending = false,
  error,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={destructive ? 'danger' : 'primary'} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  )
}

export interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accessible name; rendered visually only when `showTitle` is set. */
  title: string
  showTitle?: boolean
  side: 'left' | 'full'
  children: ReactNode
}

/** Edge-anchored modal surface: the navigation drawer and the mobile document preview. */
export function Sheet({ open, onOpenChange, title, showTitle = false, side, children }: SheetProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY} />
        <RadixDialog.Content
          aria-describedby={undefined}
          className={cx(
            'fixed z-50 flex flex-col bg-bg',
            side === 'left'
              ? 'inset-y-0 left-0 w-72 max-w-[85vw] animate-slide-in-left border-r border-line'
              : 'inset-0 animate-slide-up',
          )}
        >
          <RadixDialog.Title className={showTitle ? 'px-4 pt-4 text-base font-semibold' : 'sr-only'}>{title}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export const SheetClose = RadixDialog.Close
