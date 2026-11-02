import { describe, expect, it, vi } from 'vitest'
import { beginIdempotent, idempotencyStorageKey, readIdempotencyKey, type IdempotencyStore, type StoredResponse } from '../idempotency'
import { acquireLock, releaseLock, runAsLeader, withLock, type LockStore } from '../locks'
import { createEventBus } from '../events'
import { auditEntry } from '../audit'
import { createQueue, type QueueStore } from '../queue'
import { SagaError, runSaga } from '../saga'
import { bucketFor, isEnabled, parseFlag } from '../featureFlags'
import { signPayload, verifyWebhook } from '../webhooks'
import { UnsafeUrlError, assertSafeOutboundUrl, isBlockedHost } from '../ssrf'
import { applySecurityHeaders, handlePreflight, isOriginAllowed } from '../security'
import type { ApiRequest, ApiResponse } from '../http'

// ---- fakes ---------------------------------------------------------------------------

function fakeRes() {
  const headers: Record<string, string> = {}
  const state = { status: 0, body: '', ended: false }
  const res = {
    setHeader: (name: string, value: string) => void (headers[name.toLowerCase()] = String(value)),
    writeHead(code: number, h?: Record<string, string>) {
      state.status = code
      for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = v
      return res
    },
    write: (chunk: string) => { state.body += chunk; return true },
    end(chunk?: string) { if (chunk) state.body += chunk; state.ended = true; return res },
    headersSent: false,
  }
  return { res: res as unknown as ApiResponse, headers, state }
}
const fakeReq = (overrides: Record<string, unknown> = {}) => ({ method: 'POST', url: '/api/documents/abc/jobs', headers: {}, ...overrides }) as unknown as ApiRequest

function memoryIdempotencyStore(): IdempotencyStore & { data: Map<string, StoredResponse | 'pending'> } {
  const data = new Map<string, StoredResponse | 'pending'>()
  return {
    data,
    claim: async (key) => (data.has(key) ? false : (data.set(key, 'pending'), true)),
    get: async (key) => data.get(key) ?? null,
    save: async (key, value) => void data.set(key, value),
    release: async (key) => void data.delete(key),
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// ---- idempotency ---------------------------------------------------------------------

describe('idempotency', () => {
  it('does nothing without a key', async () => {
    const { res } = fakeRes()
    expect(await beginIdempotent(fakeReq(), res, 'u1', () => memoryIdempotencyStore())).toBe(true)
  })

  it('rejects malformed keys', async () => {
    const { res, state } = fakeRes()
    expect(await beginIdempotent(fakeReq({ headers: { 'idempotency-key': 'short' } }), res, 'u1', () => memoryIdempotencyStore())).toBe(false)
    expect(state.status).toBe(400)
    expect(readIdempotencyKey(fakeReq({ headers: { 'idempotency-key': 'has spaces in it!!' } }))).toBe('invalid')
  })

  it('runs once, stores the 2xx response, and replays it for the same user and key', async () => {
    const store = memoryIdempotencyStore()
    const req = fakeReq({ headers: { 'idempotency-key': 'key-12345678' } })

    const first = fakeRes()
    expect(await beginIdempotent(req, first.res, 'u1', () => store)).toBe(true)
    first.res.writeHead(200, { 'Content-Type': 'application/json' })
    first.res.end('{"created":true}')
    await settle()

    const second = fakeRes()
    expect(await beginIdempotent(req, second.res, 'u1', () => store)).toBe(false)
    expect(second.state.status).toBe(200)
    expect(second.state.body).toBe('{"created":true}')
    expect(second.headers['idempotent-replay']).toBe('true')
  })

  it('answers 409 while the first request is still in flight', async () => {
    const store = memoryIdempotencyStore()
    const req = fakeReq({ headers: { 'idempotency-key': 'key-12345678' } })
    await beginIdempotent(req, fakeRes().res, 'u1', () => store)
    const dup = fakeRes()
    expect(await beginIdempotent(req, dup.res, 'u1', () => store)).toBe(false)
    expect(dup.state.status).toBe(409)
    expect(dup.headers['retry-after']).toBe('2')
  })

  it('releases the key after a failure so the client can retry', async () => {
    const store = memoryIdempotencyStore()
    const req = fakeReq({ headers: { 'idempotency-key': 'key-12345678' } })
    const first = fakeRes()
    await beginIdempotent(req, first.res, 'u1', () => store)
    first.res.writeHead(502, { 'Content-Type': 'application/json' })
    first.res.end('{"error":"x"}')
    await settle()
    expect(await beginIdempotent(req, fakeRes().res, 'u1', () => store)).toBe(true)
  })

  it("never replays one user's response to another user", async () => {
    const store = memoryIdempotencyStore()
    const req = fakeReq({ headers: { 'idempotency-key': 'key-12345678' } })
    const a = fakeRes()
    await beginIdempotent(req, a.res, 'user-a', () => store)
    a.res.writeHead(200, { 'Content-Type': 'application/json' })
    a.res.end('{"secret":"a"}')
    await settle()
    const b = fakeRes()
    expect(await beginIdempotent(req, b.res, 'user-b', () => store)).toBe(true)
    expect(b.state.body).toBe('')
    expect(idempotencyStorageKey('user-a', 'POST', 'p', 'k')).not.toBe(idempotencyStorageKey('user-b', 'POST', 'p', 'k'))
  })

  it('fails open if the store is unavailable', async () => {
    const req = fakeReq({ headers: { 'idempotency-key': 'key-12345678' } })
    expect(await beginIdempotent(req, fakeRes().res, 'u1', () => { throw new Error('redis down') })).toBe(true)
  })
})

// ---- locks ---------------------------------------------------------------------------

function memoryLockStore(): LockStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    setIfAbsent: async (key, owner) => (data.has(key) ? false : (data.set(key, owner), true)),
    getOwner: async (key) => data.get(key) ?? null,
    delete: async (key) => void data.delete(key),
  }
}

describe('distributed lock', () => {
  it('grants the lock to one caller at a time', async () => {
    const store = memoryLockStore()
    const a = await acquireLock('feed', 1000, store)
    expect(a).not.toBeNull()
    expect(await acquireLock('feed', 1000, store)).toBeNull()
    expect(await releaseLock(a!, store)).toBe(true)
    expect(await acquireLock('feed', 1000, store)).not.toBeNull()
  })

  it("will not release a lock someone else now owns (expired and re-taken)", async () => {
    const store = memoryLockStore()
    const mine = await acquireLock('feed', 1000, store)
    store.data.set(mine!.key, 'another-owner')
    expect(await releaseLock(mine!, store)).toBe(false)
    expect(store.data.get(mine!.key)).toBe('another-owner')
  })

  it('withLock runs the work, releases afterwards, and reports a busy lock', async () => {
    const store = memoryLockStore()
    const ran = await withLock('job', 1000, async () => 42, { store })
    expect(ran).toEqual({ acquired: true, value: 42 })
    expect(store.data.size).toBe(0)

    await acquireLock('job', 1000, store)
    const fn = vi.fn()
    expect(await withLock('job', 1000, fn, { store })).toEqual({ acquired: false })
    expect(fn).not.toHaveBeenCalled()
  })

  it('withLock releases even when the work throws', async () => {
    const store = memoryLockStore()
    await expect(withLock('boom', 1000, async () => { throw new Error('x') }, { store })).rejects.toThrow('x')
    expect(store.data.size).toBe(0)
  })

  it('waits for a lock that frees up within waitMs', async () => {
    const store = memoryLockStore()
    const held = await acquireLock('wait', 1000, store)
    let sleeps = 0
    const result = await withLock('wait', 1000, async () => 'got it', {
      store, waitMs: 5000, pollMs: 1,
      sleep: async () => { if (++sleeps === 2) await releaseLock(held!, store) },
    })
    expect(result).toEqual({ acquired: true, value: 'got it' })
  })

  it('only one of several simultaneous instances becomes leader', async () => {
    const store = memoryLockStore()
    const work = vi.fn(async () => { await settle(); return 'ran' })
    const results = await Promise.all([1, 2, 3, 4].map(() => runAsLeader('warm', 5000, work, store)))
    expect(results.filter((r) => r.leader)).toHaveLength(1)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('fails open when the store throws', async () => {
    const broken: LockStore = { setIfAbsent: async () => { throw new Error('down') }, getOwner: async () => null, delete: async () => undefined }
    expect(await withLock('x', 1000, async () => 'still ran', { store: broken })).toEqual({ acquired: true, value: 'still ran' })
  })
})

// ---- events + audit ------------------------------------------------------------------

describe('event bus', () => {
  it('delivers to every subscriber and isolates failing handlers', async () => {
    const bus = createEventBus()
    const received: string[] = []
    bus.subscribe('document.created', () => { throw new Error('bad subscriber') })
    bus.subscribe('document.created', async (event) => void received.push(event.payload.documentId))
    await bus.publish('document.created', { documentId: 'd1' }, { userId: 'u1' })
    expect(received).toEqual(['d1'])
  })
  it('supports unsubscribe and publishing with no listeners', async () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const off = bus.subscribe('document.deleted', handler)
    off()
    await bus.publish('document.deleted', { documentId: 'd' })
    expect(handler).not.toHaveBeenCalled()
    expect(bus.listenerCount('document.deleted')).toBe(0)
  })
  it('builds a structured audit entry', () => {
    const entry = auditEntry({ name: 'document.deleted', payload: { documentId: 'd9' }, meta: { userId: 'u3', ip: '1.2.3.4', requestId: 'r1' }, at: '2026-10-27T00:00:00.000Z' })
    expect(entry).toMatchObject({ audit: true, action: 'document.deleted', actor: 'u3', ip: '1.2.3.4', requestId: 'r1', documentId: 'd9' })
  })
})

// ---- queue + DLQ ---------------------------------------------------------------------

function memoryQueueStore(): QueueStore {
  const lists = new Map<string, string[]>()
  const list = (name: string) => lists.get(name) ?? lists.set(name, []).get(name)!
  return {
    push: async (name, value) => void list(name).push(value),
    move: async (from, to) => { const v = list(from).shift(); if (v === undefined) return null; list(to).push(v); return v },
    remove: async (name, value) => { const l = list(name); const i = l.indexOf(value); if (i >= 0) l.splice(i, 1) },
    range: async (name, limit) => list(name).slice(0, limit),
    length: async (name) => list(name).length,
  }
}

describe('queue with retries and dead-letter queue', () => {
  it('delivers a job and removes it on ack', async () => {
    const q = createQueue<{ n: number }>({ name: 't1', store: memoryQueueStore() })
    await q.enqueue({ n: 1 })
    const reserved = await q.reserve()
    expect(reserved?.job.payload).toEqual({ n: 1 })
    await q.ack(reserved!)
    expect(await q.stats()).toEqual({ pending: 0, processing: 0, dead: 0 })
    expect(await q.reserve()).toBeNull()
  })

  it('retries with backoff, then dead-letters after the attempt limit', async () => {
    let now = 1000
    const q = createQueue({ name: 't2', store: memoryQueueStore(), maxAttempts: 3, baseDelayMs: 100, random: () => 1, now: () => now })
    await q.enqueue('work')

    let r = await q.reserve()
    expect(await q.fail(r!, new Error('e1'))).toBe('retry')
    expect(await q.reserve()).toBeNull() // backing off, not due yet
    now += 10_000
    r = await q.reserve()
    expect(r?.job.attempts).toBe(1)
    expect(await q.fail(r!, new Error('e2'))).toBe('retry')
    now += 10_000
    r = await q.reserve()
    expect(await q.fail(r!, new Error('e3'))).toBe('dead')

    expect(await q.stats()).toEqual({ pending: 0, processing: 0, dead: 1 })
    const dead = await q.listDead()
    expect(dead[0]).toMatchObject({ payload: 'work', attempts: 3, lastError: 'e3' })
  })

  it('requeues dead jobs with a fresh attempt count', async () => {
    const q = createQueue({ name: 't3', store: memoryQueueStore(), maxAttempts: 1 })
    await q.enqueue('x')
    await q.fail((await q.reserve())!, new Error('nope'))
    expect(await q.requeueDead()).toBe(1)
    const again = await q.reserve()
    expect(again?.job.attempts).toBe(0)
  })
})

// ---- saga ----------------------------------------------------------------------------

describe('saga', () => {
  it('runs every step in order when all succeed', async () => {
    const log: string[] = []
    await runSaga([{ name: 'a', run: async () => void log.push('a') }, { name: 'b', run: async () => void log.push('b') }], {})
    expect(log).toEqual(['a', 'b'])
  })

  it('compensates completed steps in reverse order when a step fails', async () => {
    const log: string[] = []
    const failure = runSaga([
      { name: 'row', run: async () => void log.push('row'), compensate: async () => void log.push('undo row') },
      { name: 'object', run: async () => void log.push('object'), compensate: async () => void log.push('undo object') },
      { name: 'presign', run: async () => { throw new Error('boom') }, compensate: async () => void log.push('never') },
    ], {})
    await expect(failure).rejects.toBeInstanceOf(SagaError)
    expect(log).toEqual(['row', 'object', 'undo object', 'undo row'])
  })

  it('reports compensation failures but still compensates the rest', async () => {
    const log: string[] = []
    const error = await runSaga([
      { name: 'one', run: async () => void log.push('one'), compensate: async () => void log.push('undo one') },
      { name: 'two', run: async () => void log.push('two'), compensate: async () => { throw new Error('undo failed') } },
      { name: 'three', run: async () => { throw new Error('boom') } },
    ], {}).catch((e: SagaError) => e)
    expect(error).toBeInstanceOf(SagaError)
    expect((error as SagaError).failedStep).toBe('three')
    expect((error as SagaError).compensationErrors.map((c) => c.step)).toEqual(['two'])
    expect(log).toContain('undo one')
  })
})

// ---- feature flags (canary) ----------------------------------------------------------

describe('feature flags', () => {
  it('parses on/off/percent and falls back to the default', () => {
    expect(parseFlag('true', false)).toEqual({ kind: 'on' })
    expect(parseFlag('OFF', true)).toEqual({ kind: 'off' })
    expect(parseFlag('25%', false)).toEqual({ kind: 'percent', percent: 25 })
    expect(parseFlag('100%', false)).toEqual({ kind: 'on' })
    expect(parseFlag('0%', true)).toEqual({ kind: 'off' })
    expect(parseFlag(undefined, true)).toEqual({ kind: 'on' })
    expect(parseFlag('banana', false)).toEqual({ kind: 'off' })
  })
  it('gives each user a stable answer', () => {
    const env = { FEATURE_NEW_THING: '50%' }
    expect(isEnabled('NEW_THING', 'user-1', false, env)).toBe(isEnabled('NEW_THING', 'user-1', false, env))
    expect(bucketFor('NEW_THING', 'user-1')).toBe(bucketFor('NEW_THING', 'user-1'))
  })
  it('roughly matches the requested rollout percentage', () => {
    const env = { FEATURE_CANARY: '20%' }
    let on = 0
    for (let i = 0; i < 5000; i += 1) if (isEnabled('CANARY', `user-${i}`, false, env)) on += 1
    expect(on / 5000).toBeGreaterThan(0.17)
    expect(on / 5000).toBeLessThan(0.23)
  })
  it('respects explicit on/off and the default', () => {
    expect(isEnabled('X', 'u', true, {})).toBe(true)
    expect(isEnabled('X', 'u', false, {})).toBe(false)
    expect(isEnabled('X', 'u', true, { FEATURE_X: 'false' })).toBe(false)
  })
})

// ---- webhooks ------------------------------------------------------------------------

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret'
  const body = '{"event":"paid"}'
  const now = 1_800_000_000

  it('accepts a valid signature', async () => {
    expect(await verifyWebhook(secret, body, signPayload(secret, body, now), { nowSeconds: now })).toEqual({ ok: true, timestamp: now })
  })
  it('rejects a tampered body, wrong secret, and malformed headers', async () => {
    const header = signPayload(secret, body, now)
    expect(await verifyWebhook(secret, '{"event":"refund"}', header, { nowSeconds: now })).toEqual({ ok: false, reason: 'mismatch' })
    expect(await verifyWebhook('other', body, header, { nowSeconds: now })).toEqual({ ok: false, reason: 'mismatch' })
    expect(await verifyWebhook(secret, body, 'garbage', { nowSeconds: now })).toEqual({ ok: false, reason: 'malformed' })
    expect(await verifyWebhook(secret, body, undefined, { nowSeconds: now })).toEqual({ ok: false, reason: 'malformed' })
    expect(await verifyWebhook('', body, header, { nowSeconds: now })).toEqual({ ok: false, reason: 'malformed' })
  })
  it('rejects old (and far-future) timestamps', async () => {
    expect(await verifyWebhook(secret, body, signPayload(secret, body, now - 301), { nowSeconds: now })).toEqual({ ok: false, reason: 'stale' })
    expect(await verifyWebhook(secret, body, signPayload(secret, body, now + 301), { nowSeconds: now })).toEqual({ ok: false, reason: 'stale' })
    expect((await verifyWebhook(secret, body, signPayload(secret, body, now - 299), { nowSeconds: now })).ok).toBe(true)
  })
  it('rejects a replay when the seen-before hook says so', async () => {
    const header = signPayload(secret, body, now)
    expect(await verifyWebhook(secret, body, header, { nowSeconds: now, hasSeen: async () => true })).toEqual({ ok: false, reason: 'replayed' })
  })
})

// ---- SSRF ----------------------------------------------------------------------------

describe('SSRF guard', () => {
  it.each([
    'http://localhost/x', 'https://localhost:3000', 'https://api.localhost', 'https://127.0.0.1', 'https://10.1.2.3', 'https://192.168.0.5',
    'https://172.16.5.5', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fd00::1]/',
    'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://metadata.google.internal/', 'https://0.0.0.0/', 'https://printer.local/',
  ])('blocks %s', async (url) => {
    await expect(assertSafeOutboundUrl(url, { allowHttp: true })).rejects.toBeInstanceOf(UnsafeUrlError)
  })
  it('blocks non-https unless allowed, embedded credentials, and other schemes', async () => {
    await expect(assertSafeOutboundUrl('http://example.com')).rejects.toThrow('https')
    await expect(assertSafeOutboundUrl('https://user:pw@example.com')).rejects.toThrow('credentials')
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(assertSafeOutboundUrl('not a url')).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(assertSafeOutboundUrl('http://example.com', { allowHttp: true })).resolves.toBeInstanceOf(URL)
  })
  it('allows ordinary public hosts and addresses', async () => {
    await expect(assertSafeOutboundUrl('https://chat.example.com/v1/reply')).resolves.toBeInstanceOf(URL)
    expect(isBlockedHost('8.8.8.8')).toBe(false)
    expect(isBlockedHost('example.com')).toBe(false)
  })
  it('rejects hostnames that resolve to private addresses (DNS rebinding style)', async () => {
    await expect(assertSafeOutboundUrl('https://sneaky.example.com', { resolve: true, resolver: async () => ['10.0.0.8'] })).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(assertSafeOutboundUrl('https://ok.example.com', { resolve: true, resolver: async () => ['93.184.216.34'] })).resolves.toBeInstanceOf(URL)
    await expect(assertSafeOutboundUrl('https://gone.example.com', { resolve: true, resolver: async () => { throw new Error('nx') } })).rejects.toBeInstanceOf(UnsafeUrlError)
  })
})

// ---- origin / CORS / headers ---------------------------------------------------------

describe('origin checks and CORS lockdown', () => {
  const post = (headers: Record<string, string>) => ({ method: 'POST', headers })
  it('allows same-origin and header-less requests, rejects foreign origins', () => {
    expect(isOriginAllowed(post({ host: 'app.example.com', origin: 'https://app.example.com' }), {})).toBe(true)
    expect(isOriginAllowed(post({ host: 'app.example.com' }), {})).toBe(true)
    expect(isOriginAllowed(post({ host: 'app.example.com', origin: 'https://evil.example' }), {})).toBe(false)
    expect(isOriginAllowed(post({ host: 'app.example.com', origin: 'null' }), {})).toBe(false)
  })
  it('honours X-Forwarded-Host behind a proxy and TRUSTED_ORIGINS', () => {
    expect(isOriginAllowed(post({ host: 'internal:3000', 'x-forwarded-host': 'app.example.com', origin: 'https://app.example.com' }), {})).toBe(true)
    expect(isOriginAllowed(post({ host: 'a.com', origin: 'https://b.com' }), { TRUSTED_ORIGINS: 'https://b.com/, https://c.com' })).toBe(true)
  })
  it('never blocks safe methods', () => {
    expect(isOriginAllowed({ method: 'GET', headers: { origin: 'https://evil.example', host: 'a.com' } }, {})).toBe(true)
  })
  it('answers preflight with CORS headers only for trusted origins', () => {
    const trusted = fakeRes()
    handlePreflight(fakeReq({ method: 'OPTIONS', headers: { origin: 'https://b.com' } }), trusted.res, { TRUSTED_ORIGINS: 'https://b.com' })
    expect(trusted.state.status).toBe(204)
    expect(trusted.headers['access-control-allow-origin']).toBe('https://b.com')
    const untrusted = fakeRes()
    handlePreflight(fakeReq({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), untrusted.res, {})
    expect(untrusted.state.status).toBe(204)
    expect(untrusted.headers['access-control-allow-origin']).toBeUndefined()
    expect(handlePreflight(fakeReq({ method: 'GET' }), fakeRes().res, {})).toBe(false)
  })
  it('sets the standard API security headers', () => {
    const { res, headers } = fakeRes()
    applySecurityHeaders(res)
    expect(headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'x-frame-options': 'DENY' })
  })
})

describe('isUuid', () => {
  it('accepts UUIDs and rejects everything else', async () => {
    const { isUuid } = await import('../validation')
    expect(isUuid('3f2b8c1e-9a4d-4e6b-8c2a-1d5e7f9a0b3c')).toBe(true)
    for (const bad of ['', 'abc', "1' OR '1'='1", '../../etc/passwd', '3f2b8c1e9a4d4e6b8c2a1d5e7f9a0b3c', undefined, 42]) {
      expect(isUuid(bad)).toBe(false)
    }
  })
})
