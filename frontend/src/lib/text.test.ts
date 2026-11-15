import { describe, expect, it } from 'vitest'

import { reflowSoftBreaks } from './text'

describe('reflowSoftBreaks', () => {
  it('joins line breaks inside a sentence and keeps the length', () => {
    const text = 'Deadlock prevention\nDeadlock prevention works by making sure the conditions can never\nhold. It is a check, or\nrelease it.'
    const out = reflowSoftBreaks(text)
    expect(out).toBe('Deadlock prevention\nDeadlock prevention works by making sure the conditions can never hold. It is a check, or release it.')
    expect(out).toHaveLength(text.length)
  })

  it('keeps breaks after sentence ends and before capitalised or non-letter lines', () => {
    const text = 'First sentence.\nnext line\n- item\n`code`'
    expect(reflowSoftBreaks(text)).toBe(text)
  })
})
