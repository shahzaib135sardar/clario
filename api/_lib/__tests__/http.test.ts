import { describe, expect, it } from 'vitest'
import { getBearerToken, getClientIp, getPathSegments, requireMethod, type ApiRequest, type ApiResponse } from '../http'

function fakeReq(overrides: Partial<{ headers: Record<string, string | string[]>; url: string; method: string; remoteAddress: string }> = {}): ApiRequest {
  return {
    headers: overrides.headers ?? {},
    url: overrides.url ?? '/',
    method: overrides.method ?? 'GET',
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
  } as unknown as ApiRequest
}

function fakeRes() {
  const state = { statusCode: 0, headers: {} as Record<string, string>, body: undefined as string | undefined }
  const res = {
    setHeader: (name: string, value: string) => {
      state.headers[name] = value
    },
    writeHead: (status: number) => {
      state.statusCode = status
    },
    end: (payload?: string) => {
      state.body = payload
    },
  }
  return { res: res as unknown as ApiResponse, state }
}

describe('getBearerToken', () => {
  it('extracts the token from a well-formed header', () => {
    expect(getBearerToken(fakeReq({ headers: { authorization: 'Bearer abc123' } }))).toBe('abc123')
  })

  it('returns null when the header is missing', () => {
    expect(getBearerToken(fakeReq())).toBeNull()
  })

  it('returns null for a non-Bearer scheme', () => {
    expect(getBearerToken(fakeReq({ headers: { authorization: 'Basic abc123' } }))).toBeNull()
  })

  it('returns null for an empty Bearer value', () => {
    expect(getBearerToken(fakeReq({ headers: { authorization: 'Bearer ' } }))).toBeNull()
  })
})

describe('getPathSegments', () => {
  it('splits a nested dynamic route path', () => {
    expect(getPathSegments(fakeReq({ url: '/api/documents/abc-123/confirm' }))).toEqual([
      'api',
      'documents',
      'abc-123',
      'confirm',
    ])
  })

  it('ignores a query string', () => {
    expect(getPathSegments(fakeReq({ url: '/api/documents?x=1' }))).toEqual(['api', 'documents'])
  })

  it('returns an empty array for the root path', () => {
    expect(getPathSegments(fakeReq({ url: '/' }))).toEqual([])
  })
})

describe('getClientIp', () => {
  it('prefers the first x-forwarded-for entry', () => {
    expect(getClientIp(fakeReq({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } }))).toBe('203.0.113.5')
  })

  it('falls back to the socket address', () => {
    expect(getClientIp(fakeReq({ remoteAddress: '198.51.100.9' }))).toBe('198.51.100.9')
  })
})

describe('requireMethod', () => {
  it('allows a listed method without writing a response', () => {
    const { res, state } = fakeRes()
    const allowed = requireMethod(fakeReq({ method: 'GET' }), res, ['GET', 'POST'])
    expect(allowed).toBe(true)
    expect(state.statusCode).toBe(0)
  })

  it('rejects an unlisted method with a 405 and an Allow header', () => {
    const { res, state } = fakeRes()
    const allowed = requireMethod(fakeReq({ method: 'PATCH' }), res, ['GET', 'POST'])
    expect(allowed).toBe(false)
    expect(state.statusCode).toBe(405)
    expect(state.headers.Allow).toBe('GET, POST')
    expect(state.body).toContain('PATCH')
  })
})
