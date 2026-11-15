import { describe, expect, it } from 'vitest'

import { makeHit } from '@/test/fixtures'

import { excerpt, formatCitation, groupByDocument } from './citation'

describe('formatCitation', () => {
  it('cites PDF pages by number and text documents by section, as plain text', () => {
    expect(formatCitation(makeHit({ document_title: 'os-notes', locator_kind: 'page', page_number: 2, page_label: 'Page 2', text: 'Lock ordering\n  prevents <b>circular</b> wait.' }))).toBe(
      'os-notes, p. 2 — “Lock ordering prevents <b>circular</b> wait.”',
    )
    expect(formatCitation(makeHit())).toBe('Master agreement, § Termination — “Either party may terminate with 30 days notice.”')
  })

  it('shortens long passages at a word boundary', () => {
    const long = `${'word '.repeat(80)}end`
    const short = excerpt(long, 50)
    expect(short.endsWith('…')).toBe(true)
    expect(short.length).toBeLessThanOrEqual(51)
    expect(short).not.toMatch(/\s…$/)
  })
})

describe('groupByDocument', () => {
  it('groups by document in order of each document’s best hit, keeping rank order inside', () => {
    const hits = [
      makeHit({ chunk_id: 'a1', document_id: 'a', document_title: 'A', rank: 1 }),
      makeHit({ chunk_id: 'b1', document_id: 'b', document_title: 'B', rank: 2 }),
      makeHit({ chunk_id: 'a2', document_id: 'a', document_title: 'A', rank: 3 }),
    ]
    expect(groupByDocument(hits).map((group) => [group.title, group.hits.map((hit) => hit.chunk_id)])).toEqual([
      ['A', ['a1', 'a2']],
      ['B', ['b1']],
    ])
  })
})
