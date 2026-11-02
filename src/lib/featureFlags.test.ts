import { describe, expect, it } from 'vitest'
import { parseFlag } from './featureFlags'

describe('parseFlag', () => {
  it('is off by default', () => {
    expect(parseFlag(undefined)).toBe(false)
    expect(parseFlag('')).toBe(false)
    expect(parseFlag('   ')).toBe(false)
  })

  it('turns on for true-ish values in any case', () => {
    for (const value of ['true', 'TRUE', ' 1 ', 'Yes', 'on']) expect(parseFlag(value)).toBe(true)
  })

  it('stays off for false-ish and unrecognised values', () => {
    for (const value of ['false', '0', 'no', 'off', 'maybe', '2']) expect(parseFlag(value)).toBe(false)
  })

  it('respects an explicit fallback for unset or unrecognised values only', () => {
    expect(parseFlag(undefined, true)).toBe(true)
    expect(parseFlag('banana', true)).toBe(true)
    expect(parseFlag('false', true)).toBe(false)
  })

  it('ignores non-string input', () => {
    expect(parseFlag(true as unknown)).toBe(false)
    expect(parseFlag(1 as unknown)).toBe(false)
  })
})
