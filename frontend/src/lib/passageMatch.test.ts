import { describe, expect, it } from 'vitest'

import { matchPassage, normalizeForMatch } from './passageMatch'

describe('PDF passage matching', () => {
  it('maps a unique passage across text runs without highlighting surrounding text', () => {
    expect(matchPassage(['Before. A cited ', 'passage.', ' After.'], 'A cited passage.')).toEqual([
      { item: 0, start: 8, end: 15 },
      { item: 1, start: 0, end: 8 },
    ])
  })

  it('folds whitespace, typography and ligatures but preserves source offsets', () => {
    expect(normalizeForMatch('  “Ofﬁce”\n—\tYES ')).toBe('"office"-yes')
    expect(matchPassage(['The ofﬁce — yes.'], 'office - YES')).toEqual([
      { item: 0, start: 4, end: 15 },
    ])
  })

  it('does not pick the first of repeated normalized passages', () => {
    expect(matchPassage(['Repeated passage.', ' Other text. ', 'Repeated passage.'], 'Repeated passage.')).toBeNull()
    expect(matchPassage(['Repeated passage.', ' REPEATED\nPASSAGE.'], 'Repeated passage.')).toBeNull()
  })

  it('rejects overlapping ambiguous matches too', () => {
    expect(matchPassage(['aaaa'], 'aaa')).toBeNull()
  })

  it('rejects matching head and tail anchors with an unrelated same-length middle', () => {
    const head = 'The beginning of this passage is shared exactly. '.repeat(2)
    const tail = 'The ending of this passage is shared exactly. '.repeat(2)
    const passage = `${head}${'a'.repeat(150)}${tail}`
    const page = `${head}${'z'.repeat(150)}${tail}`
    expect(matchPassage([page], passage)).toBeNull()
  })

  it('uses source UTF-16 ranges for astral characters', () => {
    expect(matchPassage(['before 🚢 harbor after'], '🚢 harbor')).toEqual([
      { item: 0, start: 7, end: 16 },
    ])
  })

  it('rejects empty and missing passages', () => {
    expect(matchPassage(['text'], ' \n ')).toBeNull()
    expect(matchPassage(['text'], 'missing')).toBeNull()
  })
})
