import * as RadixTabs from '@radix-ui/react-tabs'
import type { ComponentProps } from 'react'

import { cx } from '@/lib/cx'

export const Tabs = RadixTabs.Root

export function TabsList({ className, ...rest }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cx('flex items-center gap-1 border-b border-line', className)} {...rest} />
}

export function TabsTrigger({ className, ...rest }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cx(
        '-mb-px h-9 border-b-2 border-transparent px-3 text-[13px] font-medium text-ink-2 transition-colors duration-100',
        'hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink',
        className,
      )}
      {...rest}
    />
  )
}

export function TabsContent({ className, ...rest }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cx('focus-visible:outline-offset-[-2px]', className)} {...rest} />
}
