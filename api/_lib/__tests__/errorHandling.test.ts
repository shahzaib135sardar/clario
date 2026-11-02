import { describe, expect, it, vi } from 'vitest'
import { withErrorHandling, BadRequestError, type ApiRequest, type ApiResponse } from '../http'
import { ConfigurationError, getSupabaseConfig } from '../env'

function fakeResponse() {
  const state = { status: 0, body: '', headersSent: false }
  const res = {
    get headersSent() {
      return state.headersSent
    },
    setHeader() {},
    writeHead(status: number) {
      state.status = status
      state.headersSent = true
    },
    end(body?: string) {
      if (body) state.body = body
    },
  } as unknown as ApiResponse
  return { res, state }
}

const req = { method: 'GET', url: '/api/example', headers: {} } as unknown as ApiRequest

describe('withErrorHandling', () => {
  it('turns a ConfigurationError into a 500 that names the problem', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res, state } = fakeResponse()
    await withErrorHandling(async () => {
      throw new ConfigurationError('Server is missing the R2_BUCKET_NAME environment variable.')
    })(req, res)
    expect(state.status).toBe(500)
    expect(JSON.parse(state.body).error).toContain('R2_BUCKET_NAME')
  })

  it('maps BadRequestError to 400', async () => {
    const { res, state } = fakeResponse()
    await withErrorHandling(async () => {
      throw new BadRequestError('Request body is not valid JSON.')
    })(req, res)
    expect(state.status).toBe(400)
  })

  it('hides unexpected error details from the client', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res, state } = fakeResponse()
    await withErrorHandling(async () => {
      throw new Error('secret internal detail')
    })(req, res)
    expect(state.status).toBe(500)
    expect(state.body).not.toContain('secret internal detail')
  })
})

describe('getSupabaseConfig', () => {
  it('rejects a SUPABASE_URL that is not a URL, without echoing the value', () => {
    process.env.SUPABASE_URL = 'not-a-url-value'
    process.env.SUPABASE_ANON_KEY = 'key'
    expect(() => getSupabaseConfig()).toThrow(/https:\/\//)
    try {
      getSupabaseConfig()
    } catch (error) {
      expect((error as Error).message).not.toContain('not-a-url-value')
    }
  })

  it('accepts a normal https URL', () => {
    process.env.SUPABASE_URL = 'https://example-ref.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'key'
    expect(getSupabaseConfig().url).toBe('https://example-ref.supabase.co')
  })
})
