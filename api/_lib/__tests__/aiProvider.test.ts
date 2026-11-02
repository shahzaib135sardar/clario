import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../anthropicClient', () => ({
  completeChat: vi.fn(async () => 'anthropic-chat'),
  completeGeneration: vi.fn(async () => 'anthropic-gen'),
}))

import * as anthropic from '../anthropicClient'
import { completeChat, completeGeneration } from '../aiProvider'
import { getAiProvider } from '../env'

const originalFetch = globalThis.fetch

function mockGroqFetch(content = 'groq-reply') {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

beforeEach(() => {
  process.env.GROQ_API_KEY = 'gsk_test_key_value_000000'
  process.env.GROQ_MODEL = 'test-model'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.AI_PROVIDER
  vi.clearAllMocks()
})

describe('getAiProvider', () => {
  it('defaults to anthropic', () => {
    delete process.env.AI_PROVIDER
    expect(getAiProvider()).toBe('anthropic')
  })

  it('accepts groq in any case and ignores unknown values', () => {
    process.env.AI_PROVIDER = ' Groq '
    expect(getAiProvider()).toBe('groq')
    process.env.AI_PROVIDER = 'something-else'
    expect(getAiProvider()).toBe('anthropic')
  })
})

describe('aiProvider routing', () => {
  it('uses Claude by default and never touches Groq', async () => {
    const fetchMock = mockGroqFetch()
    await expect(completeChat('sys', [{ role: 'user', content: 'hi' }])).resolves.toBe('anthropic-chat')
    await expect(completeGeneration('sys', 'user')).resolves.toBe('anthropic-gen')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends chat to Groq with the full history when AI_PROVIDER=groq', async () => {
    process.env.AI_PROVIDER = 'groq'
    const fetchMock = mockGroqFetch('hello from groq')
    const reply = await completeChat('SYSTEM', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
    expect(reply).toBe('hello from groq')
    expect(anthropic.completeChat).not.toHaveBeenCalled()
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.model).toBe('test-model')
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('sends generation to Groq with the larger output budget when AI_PROVIDER=groq', async () => {
    process.env.AI_PROVIDER = 'groq'
    const fetchMock = mockGroqFetch('{"ok":true}')
    await expect(completeGeneration('SYS', 'USER')).resolves.toBe('{"ok":true}')
    expect(anthropic.completeGeneration).not.toHaveBeenCalled()
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.max_tokens).toBe(3072)
  })

  it('surfaces a Groq failure as a readable message without leaking the key', async () => {
    process.env.AI_PROVIDER = 'groq'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'gsk_test_key_value_000000' } }), { status: 401 }),
    ) as unknown as typeof fetch
    const error = await completeChat('SYS', [{ role: 'user', content: 'hi' }]).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('GROQ_API_KEY')
    expect((error as Error).message).not.toContain('gsk_test_key_value')
  })
})
