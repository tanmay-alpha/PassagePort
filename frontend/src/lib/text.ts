const HIGH_SURROGATE = /[\uD800-\uDBFF]/

/**
 * Converts an offset counted in Unicode code points (how the Python backend indexes page
 * text) into a UTF-16 index (how JavaScript strings are indexed). They only differ when the
 * text contains characters outside the Basic Multilingual Plane.
 */
export function codePointToUtf16(text: string, offset: number): number {
  if (offset <= 0) return 0
  if (!HIGH_SURROGATE.test(text)) return Math.min(offset, text.length)
  let index = 0
  let remaining = offset
  while (remaining > 0 && index < text.length) {
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1
    remaining -= 1
  }
  return index
}

export interface TextRange {
  before: string
  match: string
  after: string
}

/** Splits `text` around the code-point range `[start, end)`; null when the range is invalid. */
export function splitByCodePoints(text: string, start: number, end: number): TextRange | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null
  const from = codePointToUtf16(text, start)
  const to = codePointToUtf16(text, end)
  if (to <= from || from >= text.length) return null
  return { before: text.slice(0, from), match: text.slice(from, to), after: text.slice(to) }
}

export interface TextPart {
  text: string
  match: boolean
}

const TOKEN = /[\p{L}\p{N}]+/gu

/**
 * Marks the words of `text` that equal one of `terms` (case-insensitive, whole tokens).
 * `terms` are `Hit.matched_terms`: unstemmed surface tokens the keyword retriever found in
 * this passage (compound identifiers are listed together with their alphanumeric parts), so
 * only real matches light up.
 */
export function highlightTerms(text: string, terms: readonly string[]): TextPart[] {
  if (terms.length === 0 || text.length === 0) return [{ text, match: false }]
  const wanted = new Set(terms.map((term) => term.toLowerCase()))
  const parts: TextPart[] = []
  let cursor = 0
  for (const token of text.matchAll(TOKEN)) {
    if (!wanted.has(token[0].toLowerCase())) continue
    if (token.index > cursor) parts.push({ text: text.slice(cursor, token.index), match: false })
    parts.push({ text: token[0], match: true })
    cursor = token.index + token[0].length
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return parts
}

/** A line break inside a sentence: after a word or comma, before a lowercase word. */
const SOFT_BREAK = /(?<=[^\s.!?:;])\n(?=\p{Ll})/gu

/**
 * Joins the hard line breaks PDF extraction leaves inside sentences, so snippets reflow to
 * the width they are shown at instead of breaking where the original page's lines ended.
 * Breaks before a capitalised line (headings, new sentences, list items) are kept. Each break
 * becomes one space, so character offsets into the text stay valid.
 */
export function reflowSoftBreaks(text: string): string {
  return text.replace(SOFT_BREAK, ' ')
}
