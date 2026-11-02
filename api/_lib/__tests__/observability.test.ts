import { beforeEach, describe, expect, it } from 'vitest'
import { createLogger, redact, redactString, runWithContext, setContextValue, REDACTED } from '../logger'
import { formatTraceparent, outboundTraceHeaders, parseTraceparent, resolveTrace } from '../tracing'
import {
  errorBudget, fractionUnder, getCounter, incCounter, observeHistogram, percentileFromBuckets, LATENCY_BUCKETS_MS,
  recordRequest, renderPrometheus, resetMetrics, routeTemplate, sliSnapshot,
} from '../metrics'

describe('logger', () => {
  it('writes one JSON line with request context and redacts secrets', () => {
    const lines: string[] = []
    const log = createLogger((_level, line) => lines.push(line), () => new Date('2026-10-27T00:00:00Z'))
    process.env.LOG_LEVEL = 'debug'
    runWithContext({ requestId: 'req-1', traceId: 't'.repeat(32) }, () => {
      setContextValue('userId', 'user-9')
      log.info('hello', { authorization: 'Bearer abcdefghijklmnop', nested: { api_key: 'x', ok: 1 }, note: 'token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefgh' })
    })
    delete process.env.LOG_LEVEL
    const entry = JSON.parse(lines[0])
    expect(entry).toMatchObject({ level: 'info', msg: 'hello', requestId: 'req-1', userId: 'user-9', authorization: REDACTED })
    expect(entry.nested).toEqual({ api_key: REDACTED, ok: 1 })
    expect(entry.note).not.toContain('eyJhbGci')
  })
  it('masks bearer tokens and provider keys inside strings, handles cycles and errors', () => {
    expect(redactString('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain(REDACTED)
    expect(redactString('key gsk_abcdefghijklmnopqrstuv here')).not.toContain('gsk_abcdef')
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect((redact(cyclic) as Record<string, unknown>).self).toBe('[Circular]')
    expect(redact(new Error('boom'))).toMatchObject({ name: 'Error', message: 'boom' })
  })
  it('is silent under test unless LOG_LEVEL is set', () => {
    const lines: string[] = []
    createLogger((_l, line) => lines.push(line)).info('quiet')
    expect(lines).toEqual([])
  })
})

describe('tracing', () => {
  const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
  it('parses a valid traceparent and rejects invalid ones', () => {
    expect(parseTraceparent(header)).toMatchObject({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' })
    expect(parseTraceparent('nonsense')).toBeNull()
    expect(parseTraceparent(`00-${'0'.repeat(32)}-b7ad6b7169203331-01`)).toBeNull()
    expect(parseTraceparent(undefined)).toBeNull()
  })
  it('continues an inbound trace with a new span, or starts one', () => {
    const continued = resolveTrace(header)
    expect(continued.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(continued.parentSpanId).toBe('b7ad6b7169203331')
    expect(continued.spanId).not.toBe('b7ad6b7169203331')
    expect(resolveTrace(undefined).traceId).toMatch(/^[0-9a-f]{32}$/)
  })
  it('propagates the active trace to outbound calls', () => {
    expect(outboundTraceHeaders({})).toEqual({})
    const headers = outboundTraceHeaders({ traceId: 'a'.repeat(32) })
    expect(headers.traceparent).toMatch(new RegExp(`^00-${'a'.repeat(32)}-[0-9a-f]{16}-01$`))
    expect(formatTraceparent('b'.repeat(32), 'c'.repeat(16))).toBe(`00-${'b'.repeat(32)}-${'c'.repeat(16)}-01`)
  })
})

describe('metrics', () => {
  beforeEach(() => resetMetrics())

  it('counts and renders Prometheus text', () => {
    incCounter('jobs_total', { kind: 'a' })
    incCounter('jobs_total', { kind: 'a' }, 2)
    expect(getCounter('jobs_total', { kind: 'a' })).toBe(3)
    const text = renderPrometheus()
    expect(text).toContain('# TYPE jobs_total counter')
    expect(text).toContain('jobs_total{kind="a"} 3')
    expect(text).toContain('process_heap_used_bytes')
  })

  it('estimates percentiles from buckets', () => {
    for (let i = 0; i < 98; i += 1) observeHistogram('lat', 40, { route: '/x' })
    observeHistogram('lat', 2000, { route: '/x' })
    observeHistogram('lat', 2000, { route: '/x' })
    const counts = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0)
    counts[LATENCY_BUCKETS_MS.findIndex((b) => 40 <= b)] = 98
    counts[LATENCY_BUCKETS_MS.findIndex((b) => 2000 <= b)] = 2
    expect(percentileFromBuckets(counts, LATENCY_BUCKETS_MS, 0.5)).toBeLessThan(50)
    expect(percentileFromBuckets(counts, LATENCY_BUCKETS_MS, 0.99)).toBeGreaterThan(1500)
    expect(percentileFromBuckets([0, 0], [10], 0.9)).toBe(0)
  })

  it('collapses ids into route templates and bounds the path', () => {
    expect(routeTemplate('/api/documents/3f2b8c1e-1111-4222-8333-444455556666/chat?x=1')).toBe('/api/documents/:id/chat')
    expect(routeTemplate('/assets/app.js')).toBe('/other')
  })

  it('derives SLIs from recorded requests', () => {
    for (let i = 0; i < 99; i += 1) recordRequest({ method: 'GET', route: '/api/usage', status: 200, durationMs: 80 })
    recordRequest({ method: 'POST', route: '/api/documents', status: 500, durationMs: 3000 })
    const sli = sliSnapshot()
    expect(sli.total).toBe(100)
    expect(sli.failed).toBe(1)
    expect(sli.availability).toBeCloseTo(0.99)
    expect(fractionUnder(1500)).toBeCloseTo(0.99)
    expect(sli.p99Ms).toBeGreaterThan(sli.p50Ms)
  })

  it('computes error budget and burn rate', () => {
    const fine = errorBudget(0.995, 9990, 10000) // 10 bad of 50 allowed
    expect(fine.remainingFraction).toBeCloseTo(0.8)
    expect(fine.burnRate).toBeCloseTo(0.2)
    const burning = errorBudget(0.995, 9900, 10000) // 100 bad of 50 allowed
    expect(burning.remainingFraction).toBeLessThan(0)
    expect(burning.burnRate).toBeCloseTo(2)
    expect(errorBudget(0.99, 0, 0).remainingFraction).toBe(1)
    expect(() => errorBudget(1, 1, 1)).toThrow(RangeError)
  })

  it('caps label cardinality', () => {
    for (let i = 0; i < 500; i += 1) incCounter('wild', { id: `v${i}` })
    expect(renderPrometheus().split('\n').filter((l) => l.startsWith('wild{')).length).toBeLessThanOrEqual(300)
  })
})
