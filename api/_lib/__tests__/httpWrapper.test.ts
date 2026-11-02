import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BadRequestError, sendJson, withErrorHandling, type ApiRequest, type ApiResponse } from '../http'
import { OverloadedError } from '../resilience'
import { getCounter, resetMetrics } from '../metrics'
import { bearerMatches } from '../security'
import internalTask from '../../internal/[task]'

type Handler = (req: ApiRequest, res: ApiResponse) => Promise<void>
let current: Handler = async (_req, res) => sendJson(res, 200, { ok: true })
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => void current(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
afterEach(() => resetMetrics())

describe('withErrorHandling', () => {
  it('adds a request id, security headers and records metrics', async () => {
    current = withErrorHandling(async (_req, res) => sendJson(res, 200, { ok: true }))
    const response = await fetch(`${base}/api/usage`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(getCounter('http_requests_total', { method: 'GET', route: '/api/usage', status: '200' })).toBe(1)
  })

  it('echoes a sane inbound request id and ignores a hostile one', async () => {
    current = withErrorHandling(async (_req, res) => sendJson(res, 200, {}))
    expect((await fetch(`${base}/api/x`, { headers: { 'x-request-id': 'abc-12345678' } })).headers.get('x-request-id')).toBe('abc-12345678')
    expect((await fetch(`${base}/api/x`, { headers: { 'x-request-id': 'bad id with spaces' } })).headers.get('x-request-id')).not.toBe('bad id with spaces')
  })

  it('blocks cross-origin writes but allows same-origin ones', async () => {
    current = withErrorHandling(async (_req, res) => sendJson(res, 200, { ok: true }))
    const blocked = await fetch(`${base}/api/documents`, { method: 'POST', headers: { origin: 'https://evil.example' } })
    expect(blocked.status).toBe(403)
    const url = new URL(base)
    const same = await fetch(`${base}/api/documents`, { method: 'POST', headers: { origin: `http://${url.host}` } })
    expect(same.status).toBe(200)
  })

  it('answers preflight with 204 and no CORS grant for strangers', async () => {
    current = withErrorHandling(async (_req, res) => sendJson(res, 200, {}))
    const response = await fetch(`${base}/api/documents`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('maps known errors and hides unknown ones', async () => {
    current = withErrorHandling(async () => { throw new BadRequestError('nope') })
    expect((await fetch(`${base}/api/x`)).status).toBe(400)
    current = withErrorHandling(async () => { throw new OverloadedError('busy') })
    const busy = await fetch(`${base}/api/x`)
    expect(busy.status).toBe(503)
    expect(busy.headers.get('retry-after')).toBe('2')
    current = withErrorHandling(async () => { throw new Error('db password is hunter2') })
    const failed = await fetch(`${base}/api/x`)
    const text = await failed.text()
    expect(failed.status).toBe(500)
    expect(text).not.toContain('hunter2')
    expect(JSON.parse(text).requestId).toBeTruthy()
  })

  it('answers 504 when a handler hangs past the timeout', async () => {
    current = withErrorHandling(() => new Promise(() => undefined), { timeoutMs: 60 })
    const response = await fetch(`${base}/api/slow`)
    expect(response.status).toBe(504)
    expect(getCounter('http_requests_total', { method: 'GET', route: '/api/slow', status: '504' })).toBe(1)
  })
})

describe('internal operational route', () => {
  const env = { ...process.env }
  afterEach(() => { process.env = { ...env } })

  it('liveness is always ok', async () => {
    current = internalTask
    const response = await fetch(`${base}/api/internal/health`)
    expect(response.status).toBe(200)
    expect(((await response.json()) as { status: string }).status).toBe('ok')
  })

  it('metrics are hidden without a token configured and protected with one', async () => {
    current = internalTask
    delete process.env.METRICS_TOKEN
    expect((await fetch(`${base}/api/internal/metrics`)).status).toBe(404)
    process.env.METRICS_TOKEN = 'metrics-secret-token'
    expect((await fetch(`${base}/api/internal/metrics`)).status).toBe(401)
    expect((await fetch(`${base}/api/internal/metrics`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    const ok = await fetch(`${base}/api/internal/metrics`, { headers: { authorization: 'Bearer metrics-secret-token' } })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('process_heap_used_bytes')
  })

  it('the cron task needs its secret', async () => {
    current = internalTask
    delete process.env.CRON_SECRET
    expect((await fetch(`${base}/api/internal/warm-feeds`)).status).toBe(404)
    process.env.CRON_SECRET = 'cron-secret-value'
    expect((await fetch(`${base}/api/internal/warm-feeds`)).status).toBe(401)
  })

  it('unknown tasks are 404', async () => {
    current = internalTask
    expect((await fetch(`${base}/api/internal/nope`)).status).toBe(404)
  })

  it('compares secrets in constant time and rejects blanks', () => {
    expect(bearerMatches('Bearer abc', 'abc')).toBe(true)
    expect(bearerMatches('Bearer abd', 'abc')).toBe(false)
    expect(bearerMatches('Bearer ab', 'abc')).toBe(false)
    expect(bearerMatches(undefined, 'abc')).toBe(false)
    expect(bearerMatches('Bearer ', '')).toBe(false)
  })
})
