import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { describeProviderFailure } from '../anthropicClient'

const FALLBACK = 'fallback message'

function apiError(status: number, message: string): unknown {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message } }, message, new Headers())
}

describe('describeProviderFailure', () => {
  it('names the API key for a 401', () => {
    expect(describeProviderFailure(apiError(401, 'invalid x-api-key'), FALLBACK)).toContain('ANTHROPIC_API_KEY')
  })

  it('names the model variables for a 404', () => {
    const text = describeProviderFailure(apiError(404, 'model: nope'), FALLBACK)
    expect(text).toContain('ANTHROPIC_MODEL_CHAT')
    expect(text).toContain('ANTHROPIC_MODEL_GENERATION')
  })

  it('explains an empty balance on a 400', () => {
    expect(describeProviderFailure(apiError(400, 'Your credit balance is too low'), FALLBACK)).toMatch(/credit/i)
  })

  it('explains rate limiting on a 429', () => {
    expect(describeProviderFailure(apiError(429, 'slow down'), FALLBACK)).toMatch(/rate-limiting/)
  })

  it('does not leak the raw provider message', () => {
    const text = describeProviderFailure(apiError(401, 'sk-ant-SECRET-VALUE'), FALLBACK)
    expect(text).not.toContain('SECRET-VALUE')
  })

  it('falls back for anything else', () => {
    expect(describeProviderFailure(new Error('boom'), FALLBACK)).toBe(FALLBACK)
    expect(describeProviderFailure(apiError(500, 'oops'), FALLBACK)).toBe(FALLBACK)
  })
})
