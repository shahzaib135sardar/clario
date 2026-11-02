import { describe, expect, it } from 'vitest'
import { AiResponseParseError, extractJsonObject } from '../jsonExtraction'

describe('extractJsonObject', () => {
  it('parses a plain JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses JSON wrapped in a fenced code block', () => {
    const raw = 'Here you go:\n```json\n{"a": 1, "b": [1,2,3]}\n```\nLet me know if you need anything else.'
    expect(extractJsonObject(raw)).toEqual({ a: 1, b: [1, 2, 3] })
  })

  it('parses JSON wrapped in prose with no fence', () => {
    const raw = 'Sure, here is the result: {"headline": "Growth ahead", "points": []} Hope that helps!'
    expect(extractJsonObject(raw)).toEqual({ headline: 'Growth ahead', points: [] })
  })

  it('handles surrounding whitespace', () => {
    expect(extractJsonObject('\n\n  {"a": true}  \n')).toEqual({ a: true })
  })

  it('throws AiResponseParseError when no JSON can be found', () => {
    expect(() => extractJsonObject('I cannot help with that.')).toThrow(AiResponseParseError)
  })

  it('throws AiResponseParseError for malformed JSON', () => {
    expect(() => extractJsonObject('{"a": }')).toThrow(AiResponseParseError)
  })
})
