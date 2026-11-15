import type { Hit, Passage } from '@/api/types'

const EXCERPT_CHARS = 240

/** Passage text on one line, cut at a word boundary after about `max` characters. */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}

/** "p. 2" for PDF pages, "§ Connection resets" for sections of text documents. */
export function locatorLabel(passage: Pick<Passage, 'locator_kind' | 'page_number' | 'page_label'>): string {
  return passage.locator_kind === 'page' ? `p. ${passage.page_number}` : `§ ${passage.page_label}`
}

/** Plain-text citation for the clipboard: `Title, p. N — “excerpt”`. Never HTML. */
export function formatCitation(passage: Passage): string {
  return `${passage.document_title}, ${locatorLabel(passage)} — “${excerpt(passage.text)}”`
}

/** Writes plain text only, so pasting into a rich editor never carries markup from the page. */
export async function copyPlainText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is not available in this browser.')
  await navigator.clipboard.writeText(text)
}

export interface HitGroup {
  documentId: string
  title: string
  hits: Hit[]
}

/**
 * Results grouped by document. Groups are ordered by their best-ranked hit and keep the
 * server's order inside each group, so nothing is re-scored on the client.
 */
export function groupByDocument(hits: readonly Hit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>()
  for (const hit of hits) {
    const group = groups.get(hit.document_id)
    if (group) group.hits.push(hit)
    else groups.set(hit.document_id, { documentId: hit.document_id, title: hit.document_title, hits: [hit] })
  }
  return [...groups.values()]
}
