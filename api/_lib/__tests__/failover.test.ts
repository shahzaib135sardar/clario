import { describe, expect, it, vi } from 'vitest'
import { getFallbackProvider, isFailoverWorthy, withFailover } from '../aiProvider'
import { AiProviderError } from '../groqClient'
import { ConfigurationError } from '../env'
import { CircuitOpenError, TimeoutError } from '../resilience'

describe('AI provider failover', () => {
  it('reads the fallback setting and ignores one equal to the primary', () => {
    expect(getFallbackProvider({ AI_FALLBACK_PROVIDER: 'anthropic' }, 'groq')).toBe('anthropic')
    expect(getFallbackProvider({ AI_FALLBACK_PROVIDER: 'groq' }, 'groq')).toBeNull()
    expect(getFallbackProvider({ AI_FALLBACK_PROVIDER: 'nonsense' }, 'groq')).toBeNull()
    expect(getFallbackProvider({}, 'groq')).toBeNull()
  })

  it('treats outages and throttling as worth failing over, config and size problems as not', () => {
    expect(isFailoverWorthy(new CircuitOpenError('open'))).toBe(true)
    expect(isFailoverWorthy(new TimeoutError('slow'))).toBe(true)
    expect(isFailoverWorthy(new AiProviderError('Groq is rate-limiting this key.'))).toBe(true)
    expect(isFailoverWorthy(Object.assign(new Error('x'), { status: 503 }))).toBe(true)
    expect(isFailoverWorthy(Object.assign(new Error('x'), { status: 400 }))).toBe(false)
    expect(isFailoverWorthy(new ConfigurationError('missing GROQ_API_KEY'))).toBe(false)
    expect(isFailoverWorthy(new AiProviderError('The request is too large for the AI service.'))).toBe(false)
  })

  it('uses the primary when it works', async () => {
    const run = vi.fn(async (provider: string) => `ok-${provider}`)
    expect(await withFailover(run, { primary: 'groq', fallback: 'anthropic' })).toBe('ok-groq')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('fails over once to the fallback when the primary is down', async () => {
    const run = vi.fn(async (provider: string) => {
      if (provider === 'groq') throw new CircuitOpenError('groq open')
      return `ok-${provider}`
    })
    expect(await withFailover(run, { primary: 'groq', fallback: 'anthropic' })).toBe('ok-anthropic')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not fail over for configuration errors or when no fallback is set', async () => {
    const config = vi.fn(async () => { throw new ConfigurationError('missing key') })
    await expect(withFailover(config, { primary: 'groq', fallback: 'anthropic' })).rejects.toBeInstanceOf(ConfigurationError)
    expect(config).toHaveBeenCalledTimes(1)
    const down = vi.fn(async () => { throw new CircuitOpenError('open') })
    await expect(withFailover(down, { primary: 'groq', fallback: null })).rejects.toBeInstanceOf(CircuitOpenError)
  })

  it('surfaces the fallback error if both fail', async () => {
    const run = vi.fn(async (provider: string) => { throw new TimeoutError(`${provider} slow`) })
    await expect(withFailover(run, { primary: 'groq', fallback: 'anthropic' })).rejects.toThrow('anthropic slow')
  })
})
