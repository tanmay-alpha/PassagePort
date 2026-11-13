/**
 * Locates a cited passage inside the text items of a rendered PDF page.
 *
 * The server extracts page text with its own PDF library; pdf.js splits the same page into
 * differently shaped runs and puts whitespace in different places. Matching therefore ignores
 * whitespace entirely and folds typographic variants (ligatures, dashes, quotes, case). If the
 * passage still cannot be found the caller is told so — a wrong highlight is worse than none.
 */

export interface ItemRange {
  /** Index into the page's text items. */
  item: number
  /** UTF-16 range within that item's string. */
  start: number
  end: number
}

const IGNORED = /[\s\u00AD\u200B-\u200D\u2060\uFEFF]/u
const DASHES = /[\u2010-\u2015\u2212]/g
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032]/g
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g

/** Length of the head/tail anchors used when the passage does not match as one piece. */
const ANCHOR = 48
/** How far the anchored span may deviate from the passage length and still be trusted. */
const SPAN_TOLERANCE = 0.2

function fold(char: string): string {
  return char
    .normalize('NFKC')
    .toLowerCase()
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
}

/** Folded text with whitespace removed. */
export function normalizeForMatch(text: string): string {
  let out = ''
  for (const char of text) {
    for (const folded of fold(char)) {
      if (!IGNORED.test(folded)) out += folded
    }
  }
  return out
}

interface Haystack {
  text: string
  /** For every UTF-16 unit of `text`: the item it came from and the source range inside it. */
  item: number[]
  start: number[]
  end: number[]
}

function buildHaystack(items: readonly string[]): Haystack {
  const haystack: Haystack = { text: '', item: [], start: [], end: [] }
  items.forEach((value, index) => {
    let offset = 0
    for (const char of value) {
      for (const folded of fold(char)) {
        if (IGNORED.test(folded)) continue
        for (let unit = 0; unit < folded.length; unit += 1) {
          haystack.item.push(index)
          haystack.start.push(offset)
          haystack.end.push(offset + char.length)
        }
        haystack.text += folded
      }
      offset += char.length
    }
  })
  return haystack
}

function locate(haystack: string, needle: string): [number, number] | null {
  const exact = haystack.indexOf(needle)
  if (exact >= 0) return [exact, exact + needle.length]
  // The middle may differ slightly (e.g. a running header pdf.js reads mid-paragraph).
  // Accept the span between an exact head and an exact tail only if its length is plausible.
  if (needle.length < ANCHOR * 2) return null
  const head = haystack.indexOf(needle.slice(0, ANCHOR))
  if (head < 0) return null
  const tail = haystack.indexOf(needle.slice(-ANCHOR), head + ANCHOR)
  if (tail < 0) return null
  const end = tail + ANCHOR
  const deviation = Math.abs(end - head - needle.length) / needle.length
  return deviation <= SPAN_TOLERANCE ? [head, end] : null
}

/**
 * Returns the ranges of `items` covered by `passage`, in item order, or `null` when the
 * passage cannot be located with confidence.
 */
export function matchPassage(items: readonly string[], passage: string): ItemRange[] | null {
  const needle = normalizeForMatch(passage)
  if (needle.length === 0) return null
  const haystack = buildHaystack(items)
  const span = locate(haystack.text, needle)
  if (!span) return null

  const ranges: ItemRange[] = []
  for (let index = span[0]; index < span[1]; index += 1) {
    const last = ranges.at(-1)
    if (last && last.item === haystack.item[index]) {
      last.end = Math.max(last.end, haystack.end[index])
    } else {
      ranges.push({ item: haystack.item[index], start: haystack.start[index], end: haystack.end[index] })
    }
  }
  return ranges
}
