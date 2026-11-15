import { describe, expect, it } from 'vitest'

import { diffStats, diffWords, MAX_DIFF_CELLS, tokenize } from './diff'

describe('tokenize', () => {
  it('keeps numbers, hyphenated words, punctuation and whitespace runs as single tokens', () => {
    expect(tokenize('Up to 1,250 req/min — Retry-After: 2.5 s.')).toEqual([
      'Up', ' ', 'to', ' ', '1,250', ' ', 'req', '/', 'min', ' ', '—', ' ', 'Retry-After', ':', ' ', '2.5', ' ', 's', '.',
    ])
  })
})

describe('diffWords', () => {
  it('reports a changed number as one removed and one added token', () => {
    expect(
      diffWords(
        'Each API key may send up to 100 requests per minute.',
        'Each API key may send up to 250 requests per minute.',
      ),
    ).toEqual([
      { kind: 'equal', text: 'Each API key may send up to ', numeric: false },
      { kind: 'removed', text: '100', numeric: true },
      { kind: 'added', text: '250', numeric: true },
      { kind: 'equal', text: ' requests per minute.', numeric: false },
    ])
  })

  it('groups adjacent word changes across the space between them', () => {
    expect(diffWords('Pagination is offset based.', 'Pagination is cursor driven.')).toEqual([
      { kind: 'equal', text: 'Pagination is ', numeric: false },
      { kind: 'removed', text: 'offset based', numeric: false },
      { kind: 'added', text: 'cursor driven', numeric: false },
      { kind: 'equal', text: '.', numeric: false },
    ])
  })

  it('reports pure insertions and deletions', () => {
    expect(diffWords('Tokens expire.', 'Access tokens expire after 1 hour.')).toEqual([
      { kind: 'removed', text: 'Tokens', numeric: false },
      { kind: 'added', text: 'Access tokens', numeric: false },
      { kind: 'equal', text: ' expire', numeric: false },
      { kind: 'added', text: ' after 1 hour', numeric: true },
      { kind: 'equal', text: '.', numeric: false },
    ])
  })

  it('ignores differences that are only whitespace', () => {
    expect(diffWords('one  two\nthree', 'one two three')).toEqual([{ kind: 'equal', text: 'one  two\nthree', numeric: false }])
  })

  it('gives up instead of building a huge table', () => {
    const words = (prefix: string) => Array.from({ length: 1500 }, (_, index) => `${prefix}${index}`).join(' ')
    expect((2 * 1500) ** 2).toBeGreaterThan(MAX_DIFF_CELLS)
    expect(diffWords(words('a'), words('b'))).toBeNull()
  })

  it('round-trips: equal + removed rebuilds a, equal + added rebuilds b', () => {
    const a = 'The default page size is 25 items and the maximum is 200.'
    const b = 'The default page size is 50 items; the maximum is 200.'
    const parts = diffWords(a, b) ?? []
    expect(parts.filter((part) => part.kind !== 'added').map((part) => part.text).join('')).toBe(a)
    expect(parts.filter((part) => part.kind !== 'removed').map((part) => part.text).join('')).toBe(b)
    expect(diffStats(parts)).toEqual({ removed: 2, added: 2, numeric: 1 })
  })
})
