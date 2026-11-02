import { describe, expect, it } from 'vitest'
import { truncateForContext } from '../documentContext'

describe('truncateForContext', () => {
  it('returns short text unchanged', () => {
    expect(truncateForContext('hello', 10)).toEqual({ text: 'hello', truncated: false })
  })

  it('returns text at exactly the limit unchanged', () => {
    expect(truncateForContext('a'.repeat(10), 10)).toEqual({ text: 'a'.repeat(10), truncated: false })
  })

  it('truncates text past the limit and reports it', () => {
    const result = truncateForContext('a'.repeat(15), 10)
    expect(result.text).toBe('a'.repeat(10))
    expect(result.truncated).toBe(true)
  })
})
