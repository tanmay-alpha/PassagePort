import { Fragment } from 'react'

import { Dialog } from '@/components/ui/Dialog'
import { Kbd } from '@/components/ui/Feedback'

interface Shortcut {
  /** Alternative key combinations; keys inside one combination are pressed together. */
  combos: string[][]
  description: string
}

const SHORTCUTS: Shortcut[] = [
  { combos: [['/'], ['Ctrl', 'K'], ['⌘', 'K']], description: 'Search the current workspace' },
  { combos: [['↑'], ['↓']], description: 'Move between results' },
  { combos: [['Enter']], description: 'Open the focused result in the preview' },
  { combos: [['Esc']], description: 'Close the preview, menu or dialog' },
  { combos: [['←'], ['→']], description: 'Resize the preview when the divider is focused' },
  { combos: [['?']], description: 'Show this list' },
]

export function ShortcutList() {
  return (
    <dl className="divide-y divide-line text-sm">
      {SHORTCUTS.map((shortcut) => (
        <div key={shortcut.description} className="flex items-center justify-between gap-4 py-2">
          <dt className="text-ink">{shortcut.description}</dt>
          <dd className="flex shrink-0 items-center gap-1.5 text-ink-3">
            {shortcut.combos.map((combo, index) => (
              <Fragment key={combo.join('+')}>
                {index > 0 ? <span className="text-xs">or</span> : null}
                <span className="inline-flex items-center gap-0.5">
                  {combo.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </Fragment>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" size="md">
      <ShortcutList />
    </Dialog>
  )
}
