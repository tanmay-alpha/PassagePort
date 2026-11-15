/**
 * Word-level diff between two passages, computed in the browser from their text: tokens are
 * words, numbers, single punctuation marks and whitespace runs; the longest common subsequence
 * of tokens is kept and everything else is reported as removed (only in `a`) or added (only in
 * `b`). Whitespace differences alone never count as a change.
 */

export type DiffKind = 'equal' | 'removed' | 'added'

export interface DiffPart {
  kind: DiffKind
  text: string
  /** The changed text contains a number; the UI emphasises these. */
  numeric: boolean
}

/** Above this many LCS cells (≈ two 1,400-token passages) the diff is not attempted. */
export const MAX_DIFF_CELLS = 2_000_000

const TOKEN = /\p{N}+(?:[.,:/]\p{N}+)*%?|[\p{L}\p{M}\p{N}_]+(?:['’-][\p{L}\p{M}\p{N}_]+)*|\s+|[^\s\p{L}\p{M}\p{N}]/gu
const DIGIT = /\p{N}/u
const SPACE = /^\s+$/

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/** Comparison key: every whitespace run is the same token. */
function key(token: string): string {
  return SPACE.test(token) ? ' ' : token
}

interface Op {
  kind: DiffKind
  text: string
}

function push(ops: Op[], kind: DiffKind, text: string): void {
  const last = ops.at(-1)
  if (last && last.kind === kind) last.text += text
  else ops.push({ kind, text })
}

function tokenOps(a: string[], b: string[]): Op[] | null {
  const ka = a.map(key)
  const kb = b.map(key)
  // Common prefix and suffix need no table.
  let start = 0
  while (start < ka.length && start < kb.length && ka[start] === kb[start]) start += 1
  let endA = ka.length
  let endB = kb.length
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const n = endA - start
  const m = endB - start
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null

  // lcs[i][j]: LCS length of a[start+i..endA) and b[start+j..endB), stored row-major.
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        ka[start + i] === kb[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }

  const ops: Op[] = []
  for (let index = 0; index < start; index += 1) push(ops, 'equal', a[index])
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ka[start + i] === kb[start + j]) {
      push(ops, 'equal', a[start + i])
      i += 1
      j += 1
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      push(ops, 'removed', a[start + i])
      i += 1
    } else {
      push(ops, 'added', b[start + j])
      j += 1
    }
  }
  for (; i < n; i += 1) push(ops, 'removed', a[start + i])
  for (; j < m; j += 1) push(ops, 'added', b[start + j])
  for (let index = endA; index < a.length; index += 1) push(ops, 'equal', a[index])
  return ops
}

/**
 * Readable change runs: a whitespace-only "equal" between two changes is folded into both
 * sides, and within each run the removed text comes before the added text. Whitespace both
 * sides end with goes back to the unchanged text.
 */
function groupChanges(ops: Op[]): DiffPart[] {
  const parts: DiffPart[] = []
  let removed = ''
  let added = ''
  const flush = () => {
    const tail = removed && added ? (removed.match(/\s+$/)?.[0] ?? '') : ''
    const shared = tail !== '' && added.endsWith(tail) && tail.length < removed.length && tail.length < added.length
    if (shared) {
      removed = removed.slice(0, -tail.length)
      added = added.slice(0, -tail.length)
    }
    if (removed) parts.push({ kind: 'removed', text: removed, numeric: DIGIT.test(removed) })
    if (added) parts.push({ kind: 'added', text: added, numeric: DIGIT.test(added) })
    if (shared) parts.push({ kind: 'equal', text: tail, numeric: false })
    removed = ''
    added = ''
  }
  ops.forEach((op, index) => {
    if (op.kind === 'removed') removed += op.text
    else if (op.kind === 'added') added += op.text
    else {
      const inRun = (removed || added) && SPACE.test(op.text) && ops[index + 1] !== undefined
      if (inRun) {
        removed += op.text
        added += op.text
        return
      }
      flush()
      const last = parts.at(-1)
      if (last?.kind === 'equal') last.text += op.text
      else parts.push({ kind: 'equal', text: op.text, numeric: false })
    }
  })
  flush()
  return parts
}

/**
 * The changes that turn `a` into `b`, or null when the passages are too long to compare
 * token by token. Joining the `equal` + `removed` parts gives `a` back (modulo whitespace
 * runs, which are taken from `a`), `equal` + `added` gives `b`.
 */
export function diffWords(a: string, b: string): DiffPart[] | null {
  const ops = tokenOps(tokenize(a), tokenize(b))
  return ops ? groupChanges(ops) : null
}

/**
 * Changed words on each side, and how many changes involve a number (a removed part and the
 * added part that replaces it count as one change).
 */
export function diffStats(parts: readonly DiffPart[]): { removed: number; added: number; numeric: number } {
  let removed = 0
  let added = 0
  let numeric = 0
  parts.forEach((part, index) => {
    if (part.kind === 'equal') return
    const words = tokenize(part.text).filter((token) => !SPACE.test(token)).length
    if (part.kind === 'removed') removed += words
    else added += words
    const previous = parts[index - 1]
    const replacesNumber = part.kind === 'added' && previous?.kind === 'removed' && previous.numeric
    if (part.numeric && !replacesNumber) numeric += 1
  })
  return { removed, added, numeric }
}
