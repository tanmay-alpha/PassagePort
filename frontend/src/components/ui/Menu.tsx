import * as RadixMenu from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Link } from 'react-router'

import { cx } from '@/lib/cx'

export const Menu = RadixMenu.Root
export const MenuTrigger = RadixMenu.Trigger

const ITEM =
  'flex min-h-8 cursor-default items-center gap-2 rounded px-2 py-1 text-sm outline-none select-none ' +
  'data-[highlighted]:bg-subtle data-[disabled]:opacity-50'

export function MenuContent({ className, align = 'start', children, ...rest }: ComponentProps<typeof RadixMenu.Content>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={4}
        collisionPadding={8}
        className={cx(
          'z-[60] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-44 animate-pop-in overflow-y-auto',
          'rounded-md border border-line bg-surface p-1 text-ink shadow-pop',
          className,
        )}
        {...rest}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  )
}

export interface MenuItemProps extends ComponentProps<typeof RadixMenu.Item> {
  icon?: ReactNode
  destructive?: boolean
}

export function MenuItem({ icon, destructive = false, className, children, ...rest }: MenuItemProps) {
  return (
    <RadixMenu.Item className={cx(ITEM, destructive ? 'text-danger' : 'text-ink', className)} {...rest}>
      {icon ? <span className="flex size-4 shrink-0 items-center justify-center text-current opacity-80">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </RadixMenu.Item>
  )
}

export interface MenuLinkItemProps {
  icon?: ReactNode
  children: ReactNode
  /** In-app destination. */
  to?: string
  /** Plain URL, for downloads. */
  href?: string
  download?: string
}

/** A menu item that is a real link, so it can be opened in a new tab or downloaded. */
export function MenuLinkItem({ icon, children, to, href, download }: MenuLinkItemProps) {
  const content = (
    <>
      {icon ? <span className="flex size-4 shrink-0 items-center justify-center opacity-80">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </>
  )
  return (
    <RadixMenu.Item asChild className={cx(ITEM, 'text-ink')}>
      {to !== undefined ? (
        <Link to={to}>{content}</Link>
      ) : (
        <a href={href} download={download}>
          {content}
        </a>
      )}
    </RadixMenu.Item>
  )
}

export function MenuCheckboxItem({ className, children, ...rest }: ComponentProps<typeof RadixMenu.CheckboxItem>) {
  return (
    <RadixMenu.CheckboxItem className={cx(ITEM, 'text-ink', className)} {...rest}>
      <span className="flex size-4 shrink-0 items-center justify-center rounded border border-line-strong">
        <RadixMenu.ItemIndicator>
          <Check size={12} aria-hidden="true" />
        </RadixMenu.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </RadixMenu.CheckboxItem>
  )
}

export function MenuLabel({ className, ...rest }: ComponentProps<typeof RadixMenu.Label>) {
  return <RadixMenu.Label className={cx('px-2 py-1.5 text-xs font-medium text-ink-3', className)} {...rest} />
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="-mx-1 my-1 h-px bg-line" />
}
