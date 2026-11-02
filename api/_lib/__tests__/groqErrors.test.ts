import { describe, expect, it } from 'vitest'
import { describeGroqFailure } from '../groqClient'

describe('describeGroqFailure', () => {
  it('names GROQ_API_KEY for a 401', () => {
    expect(describeGroqFailure(401, '{"error":{"code":"invalid_api_key"}}')).toContain('GROQ_API_KEY')
  })

  it('names GROQ_MODEL for a missing or retired model', () => {
    expect(describeGroqFailure(404, '')).toContain('GROQ_MODEL')
    expect(describeGroqFailure(400, '{"error":{"code":"model_decommissioned"}}')).toContain('GROQ_MODEL')
    expect(describeGroqFailure(404, '')).toContain('check-ai')
  })

  it('explains rate limits and oversized requests', () => {
    expect(describeGroqFailure(429, '')).toMatch(/rate-limiting/)
    expect(describeGroqFailure(413, '')).toMatch(/too large/)
  })

  it('never echoes provider text', () => {
    const text = describeGroqFailure(401, '{"error":{"message":"key gsk_SECRET is bad","code":"invalid_api_key"}}')
    expect(text).not.toContain('gsk_SECRET')
  })

  it('falls back to the generic message', () => {
    expect(describeGroqFailure(500, 'not json')).toBe('The AI service could not process this request.')
  })
})
