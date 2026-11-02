import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { createGateway } from '../app'
import { clientIp, createInflightLimiter, toRateDecision, waitForDrain } from '../gateway'
import { ROUTES, expectedPatternForFile, matchRoute, normalizeApiPath } from '../routes'
import { buildSecurityHeaders, ensureRequestId, evaluateOrigin, CSP_DIRECTIVES } from '../security'
import { cacheControlFor, chooseEncoding, isSpaRoute, resolveStaticPath } from '../static'

// ---- route table ---------------------------------------------------------------------

function apiFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return entry === '_lib' || entry === '__tests__' ? [] : apiFiles(full, `${prefix}${entry}/`)
    return entry.endsWith('.ts') ? [`${prefix}${entry}`] : []
  })
}

describe('route table', () => {
  it('has a route for every function file under api/, and no extras', () => {
    const files = apiFiles(path.resolve(__dirname, '../../api')).sort()
    expect(ROUTES.map((route) => route.file).sort()).toEqual(files)
    for (const route of ROUTES) expect(route.pattern).toBe(expectedPatternForFile(route.file))
  })
  it('keeps the project within the 12-function Vercel Hobby limit', () => {
    expect(apiFiles(path.resolve(__dirname, '../../api')).length).toBeLessThanOrEqual(12)
  })
  it('matches ids, nested routes and the /api/v1 alias', () => {
    expect(matchRoute('/api/documents')?.route.file).toBe('documents/index.ts')
    expect(matchRoute('/api/documents/abc-123')?.params).toEqual({ id: 'abc-123' })
    expect(matchRoute('/api/documents/abc/chat')?.route.file).toBe('documents/[id]/chat.ts')
    expect(matchRoute('/api/v1/documents/abc/jobs')?.route.file).toBe('documents/[id]/jobs.ts')
    expect(matchRoute('/api/internal/health')?.params).toEqual({ task: 'health' })
    expect(matchRoute('/api/documents/abc/chat/')?.route.file).toBe('documents/[id]/chat.ts')
  })
  it('does not match unknown or non-api paths', () => {
    expect(matchRoute('/api/nope')).toBeNull()
    expect(matchRoute('/api/documents/a/b/c')).toBeNull()
    expect(matchRoute('/dashboard')).toBeNull()
    expect(normalizeApiPath('/apiary')).toBeNull()
  })
})

// ---- static files --------------------------------------------------------------------

describe('static serving helpers', () => {
  const root = path.resolve('/srv/app/dist')
  it('rejects path traversal, dotfiles, backslashes and null bytes', () => {
    expect(resolveStaticPath(root, '/../../etc/passwd')).toBeNull()
    expect(resolveStaticPath(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(resolveStaticPath(root, '/assets/..%2f..%2fsecret')).toBeNull()
    expect(resolveStaticPath(root, '/.env')).toBeNull()
    expect(resolveStaticPath(root, '/a\\b')).toBeNull()
    expect(resolveStaticPath(root, '/a%00b')).toBeNull()
    expect(resolveStaticPath(root, '/%E0%A4%A')).toBeNull()
  })
  it('maps normal paths inside the root', () => {
    expect(resolveStaticPath(root, '/assets/app.js')).toBe(path.join(root, 'assets', 'app.js'))
    expect(resolveStaticPath(root, '/index.html')).toBe(path.join(root, 'index.html'))
  })
  it('chooses caching, SPA fallback and encodings', () => {
    expect(cacheControlFor('/assets/index-abc.js')).toContain('immutable')
    expect(cacheControlFor('/sw.js')).toBe('no-cache')
    expect(cacheControlFor('/')).toBe('no-cache')
    expect(isSpaRoute('/settings/usage')).toBe(true)
    expect(isSpaRoute('/assets/missing.js')).toBe(false)
    expect(chooseEncoding('gzip, deflate, br')).toBe('br')
    expect(chooseEncoding('gzip')).toBe('gzip')
    expect(chooseEncoding(undefined)).toBeNull()
  })
})

// ---- gateway building blocks ---------------------------------------------------------

describe('gateway building blocks', () => {
  it('limits concurrent requests (backpressure)', () => {
    const limiter = createInflightLimiter(2)
    expect([limiter.tryEnter(), limiter.tryEnter(), limiter.tryEnter()]).toEqual([true, true, false])
    limiter.leave()
    expect(limiter.tryEnter()).toBe(true)
    expect(limiter.count()).toBe(2)
  })
  it('only trusts X-Forwarded-For behind a proxy', () => {
    const req = { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } } as never
    expect(clientIp(req, true)).toBe('9.9.9.9')
    expect(clientIp(req, false)).toBe('10.0.0.1')
  })
  it('turns limiter results into decisions and fails open', () => {
    expect(toRateDecision(null)).toEqual({ allowed: true })
    expect(toRateDecision({ success: true, resetAt: 0 })).toEqual({ allowed: true })
    expect(toRateDecision({ success: false, resetAt: 10_500 }, 10_000)).toEqual({ allowed: false, retryAfterSeconds: 1 })
    expect(toRateDecision({ success: false, resetAt: 40_000 }, 10_000)).toEqual({ allowed: false, retryAfterSeconds: 30 })
  })
  it('drains in-flight work before the deadline, or reports what is left', async () => {
    let inFlight = 2
    let clock = 0
    const drained = await waitForDrain({ inFlight: () => inFlight, drainMs: 1000, sleep: async (ms) => { clock += ms; inFlight = Math.max(0, inFlight - 1) }, now: () => clock, pollMs: 100 })
    expect(drained).toEqual({ drained: true, remaining: 0 })
    const stuck = await waitForDrain({ inFlight: () => 3, drainMs: 500, sleep: async (ms) => { clock += ms }, now: () => clock, pollMs: 100 })
    expect(stuck).toEqual({ drained: false, remaining: 3 })
  })
})

describe('security helpers', () => {
  it('only sends HSTS and upgrade-insecure-requests over https', () => {
    expect(buildSecurityHeaders(false)['Strict-Transport-Security']).toBeUndefined()
    expect(buildSecurityHeaders(false)['Content-Security-Policy']).not.toContain('upgrade-insecure-requests')
    expect(buildSecurityHeaders(true)['Strict-Transport-Security']).toContain('max-age=63072000')
    expect(buildSecurityHeaders(true)['Content-Security-Policy']).toContain('upgrade-insecure-requests')
  })
  it('keeps the CSP strict where it matters', () => {
    expect(CSP_DIRECTIVES).toContain("object-src 'none'")
    expect(CSP_DIRECTIVES).toContain("frame-ancestors 'none'")
    expect(CSP_DIRECTIVES.find((directive) => directive.startsWith('script-src'))).not.toContain('unsafe')
  })
  it('keeps vercel.json and the server CSP identical', () => {
    const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] }
    const csp = vercel.headers.flatMap((entry) => entry.headers).find((header) => header.key === 'Content-Security-Policy')?.value ?? ''
    for (const directive of CSP_DIRECTIVES) expect(csp).toContain(directive)
  })
  it('does not rewrite dev-server or file paths to index.html, but does rewrite page routes', () => {
    const vercel = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8')) as { rewrites: { source: string }[] }
    const spa = vercel.rewrites.find((rewrite) => rewrite.source.includes('index') || rewrite.source.startsWith('/(('))
    const pattern = new RegExp(`^${spa?.source}$`)
    for (const page of ['/', '/settings/usage', '/jobs', '/documents/abc']) expect(pattern.test(page), page).toBe(true)
    for (const file of ['/src/main.tsx', '/@vite/client', '/@react-refresh', '/node_modules/.vite/deps/react.js', '/assets/app.js', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/api/documents']) expect(pattern.test(file), file).toBe(false)
  })
  it('keeps good request ids and replaces bad ones', () => {
    expect(ensureRequestId('abc-12345678')).toBe('abc-12345678')
    expect(ensureRequestId('x')).not.toBe('x')
    expect(ensureRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('judges origins', () => {
    expect(evaluateOrigin({ origin: undefined, host: 'a.com', trusted: [] })).toBe('none')
    expect(evaluateOrigin({ origin: 'https://a.com', host: 'a.com', trusted: [] })).toBe('same-origin')
    expect(evaluateOrigin({ origin: 'https://b.com', host: 'a.com', trusted: ['https://b.com'] })).toBe('trusted')
    expect(evaluateOrigin({ origin: 'https://evil.com', host: 'a.com', trusted: [] })).toBe('denied')
    expect(evaluateOrigin({ origin: 'null', host: 'a.com', trusted: [] })).toBe('denied')
    expect(evaluateOrigin({ origin: 'https://a.com', host: 'internal', forwardedHost: 'a.com', trusted: [] })).toBe('same-origin')
  })
})

describe('config', () => {
  it('has safe defaults and clamps bad values', () => {
    const config = loadConfig({})
    expect(config).toMatchObject({ port: 8080, trustProxy: false, maxInFlight: 100 })
    expect(loadConfig({ PORT: 'abc', MAX_IN_FLIGHT: '999999999' })).toMatchObject({ port: 8080, maxInFlight: 10_000 })
    expect(loadConfig({ TRUST_PROXY: 'true', TRUSTED_ORIGINS: 'https://a.com/, https://b.com' })).toMatchObject({ trustProxy: true, trustedOrigins: ['https://a.com', 'https://b.com'] })
  })
})

// ---- the running gateway -------------------------------------------------------------

describe('gateway over HTTP', () => {
  let server: Server
  let base = ''
  let dir = ''
  const calls: string[] = []
  let allow = true

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'clario-static-'))
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>')
    writeFileSync(path.join(dir, 'assets', 'app-abc.js'), 'console.log(1)')
    const gateway = createGateway(loadConfig({ STATIC_DIR: dir, MAX_IN_FLIGHT: '1', PORT: '0', HOST: '127.0.0.1' }), {
      rateLimiter: async () => (allow ? { success: true, resetAt: 0 } : { success: false, resetAt: Date.now() + 5000 }),
      routes: [
        { pattern: '/api/ping', file: 'ping.ts', load: async () => ({ default: async (req, res) => { calls.push(req.url ?? ''); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"pong":true}') } }) },
        { pattern: '/api/slow', file: 'slow.ts', load: async () => ({ default: async (_req, res) => { await new Promise((resolve) => setTimeout(resolve, 150)); res.writeHead(200); res.end('slow') } }) },
        { pattern: '/api/boom', file: 'boom.ts', load: async () => ({ default: async () => { throw new Error('secret detail') } }) },
        { pattern: '/api/internal/:task', file: 'internal/[task].ts', load: async () => ({ default: async (req, res) => { res.writeHead(200); res.end(req.url) } }) },
      ],
    })
    server = gateway.listen()
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))

  it('serves liveness, the app shell and hashed assets with the right headers', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    const shell = await fetch(`${base}/settings/usage`)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('shell')
    expect(shell.headers.get('cache-control')).toBe('no-cache')
    expect(shell.headers.get('x-content-type-options')).toBe('nosniff')
    expect(shell.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(shell.headers.get('x-request-id')).toBeTruthy()
    expect((await fetch(`${base}/assets/app-abc.js`)).headers.get('cache-control')).toContain('immutable')
  })

  it('404s missing assets and traversal attempts instead of the shell', async () => {
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${base}/..%2f..%2fetc/passwd`)).status).toBe(404)
    expect((await fetch(`${base}/.env`)).status).toBe(404)
  })

  it('routes API calls (including the /api/v1 alias) and 404s unknown API paths as JSON', async () => {
    expect(await (await fetch(`${base}/api/ping`)).json()).toEqual({ pong: true })
    await fetch(`${base}/api/v1/ping?x=1`)
    expect(calls).toContain('/api/ping?x=1')
    const missing = await fetch(`${base}/api/nope`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('application/json')
  })

  it('rate-limits per IP with Retry-After, but not the operational endpoints', async () => {
    allow = false
    const limited = await fetch(`${base}/api/ping`)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect((await fetch(`${base}/api/internal/health`)).status).toBe(200)
    allow = true
  })

  it('pushes back with 503 when the in-flight cap is reached', async () => {
    const first = fetch(`${base}/api/slow`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const second = await fetch(`${base}/api/ping`)
    expect(second.status).toBe(503)
    expect(second.headers.get('retry-after')).toBe('1')
    expect((await first).status).toBe(200)
  })

  it('hides handler failures and rejects oversized bodies', async () => {
    const boom = await fetch(`${base}/api/boom`)
    expect(boom.status).toBe(500)
    expect(await boom.text()).not.toContain('secret detail')
    const big = await fetch(`${base}/api/ping`, { method: 'POST', headers: { 'content-length': '999999999' }, body: 'x' }).catch(() => null)
    expect(big === null || big.status === 413).toBe(true)
  })

  it('aliases /readyz to the readiness task', async () => {
    expect(await (await fetch(`${base}/readyz`)).text()).toBe('/api/internal/ready')
  })
})
