import { ChevronDown, Filter } from 'lucide-react'

import type { DocumentOut } from '@/api/types'
import { buttonClass } from '@/components/ui/Button'
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { plural } from '@/lib/format'

/** Comma-separated id list as used in the `docs` URL parameter. */
export function parseIdList(value: string | null): string[] {
  return value ? value.split(',').filter(Boolean) : []
}

export interface DocumentFilterProps {
  /** Documents that can be searched (indexed ones). */
  documents: DocumentOut[]
  selected: string[]
  onChange: (selected: string[]) => void
  /** Upper bound on the selection, if any (Compare allows four). */
  max?: number
  allLabel?: string
}

/** Multi-select restricting retrieval to some documents; nothing selected means all of them. */
export function DocumentFilter({ documents, selected, onChange, max, allLabel = 'All documents' }: DocumentFilterProps) {
  const chosen = selected.filter((id) => documents.some((document) => document.id === id))
  const atLimit = max !== undefined && chosen.length >= max
  const summary = chosen.length === 0 ? allLabel : plural(chosen.length, 'document')

  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...chosen, id] : chosen.filter((item) => item !== id))
  }

  return (
    <Menu>
      <MenuTrigger
        className={buttonClass('secondary', 'md', 'max-w-full justify-between font-normal')}
        disabled={documents.length === 0}
        aria-label={`Documents: ${summary}`}
      >
        <Filter size={14} className="text-ink-3" aria-hidden="true" />
        <span className="truncate">{summary}</span>
        <ChevronDown size={14} className="text-ink-3" aria-hidden="true" />
      </MenuTrigger>
      <MenuContent className="w-72">
        <MenuLabel>{max ? `Choose up to ${max} documents` : 'Limit to documents'}</MenuLabel>
        {documents.map((document) => {
          const checked = chosen.includes(document.id)
          return (
            <MenuCheckboxItem
              key={document.id}
              checked={checked}
              disabled={!checked && atLimit}
              onCheckedChange={(next) => toggle(document.id, next)}
              // Keep the menu open so several documents can be ticked in one go.
              onSelect={(event) => event.preventDefault()}
            >
              {document.title}
            </MenuCheckboxItem>
          )
        })}
        {chosen.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => onChange([])}>Clear selection</MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  )
}
