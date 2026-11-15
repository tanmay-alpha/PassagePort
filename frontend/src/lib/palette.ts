export interface PaletteEntry {
  id: string
  label: string
  /** Extra words that should match, e.g. a file name or a synonym. */
  keywords?: string
}

/**
 * How well `query` matches an entry; lower is better, null is no match. Every query word must
 * occur in the label or keywords. The label starting with the query beats a word in the label
 * starting with it, which beats a match anywhere.
 */
export function matchScore(entry: PaletteEntry, query: string): number | null {
  const needle = query.trim().toLowerCase()
  if (needle === '') return 0
  const label = entry.label.toLowerCase()
  const haystack = `${label} ${entry.keywords?.toLowerCase() ?? ''}`
  const words = needle.split(/\s+/)
  if (!words.every((word) => haystack.includes(word))) return null
  if (label.startsWith(needle)) return 0
  if (label.split(/[\s·._-]+/).some((word) => word.startsWith(words[0]))) return 1
  return label.includes(needle) ? 2 : 3
}

/** Matching entries, best first; ties keep their original order. */
export function filterEntries<T extends PaletteEntry>(entries: readonly T[], query: string, limit = Infinity): T[] {
  return entries
    .map((entry, index) => ({ entry, index, score: matchScore(entry, query) }))
    .filter((item): item is { entry: T; index: number; score: number } => item.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.entry)
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere, for shortcut hints. */
export function modifierLabel(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl'
}
