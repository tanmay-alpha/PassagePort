import type { ComponentProps } from 'react'

import { cx } from '@/lib/cx'

export interface ScrollRegionProps extends ComponentProps<'div'> {
  /** Accessible name of the region, announced when it receives focus. */
  label: string
}

/**
 * A box whose content can overflow and scroll (wide tables, charts, a zoomed PDF page). It is
 * focusable so keyboard users can scroll it with the arrow keys even when it holds nothing
 * else to focus.
 */
export function ScrollRegion({ label, className, children, ...rest }: ScrollRegionProps) {
  return (
    <div
      role="region"
      aria-label={label}
      // A scrollable region without focusable content must itself be focusable (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={cx('focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent', className)}
      {...rest}
    >
      {children}
    </div>
  )
}
