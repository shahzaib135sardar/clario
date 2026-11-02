import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CircuitBreaker, CircuitOpenError, OverloadedError, TimeoutError, backoffDelay, createBulkhead, getBreaker, maybeInjectChaos,
  resetBreakers, resilientFetch, retry, withTimeout, ChaosError,
} from '../resilience'

afterEach(() => {
  vi.useRealTimers()
  resetBreakers()
})

const noSleep = async () => undefined

describe('withTimeout', () => {
  it('resolves fast work and aborts the signal on timeout', async () => {
    vi.useFakeTimers()
    await expect(withTimeout(async () => 'ok', 1000)).resolves.toBe('ok')
    let aborted = false
    const slow = withTimeout((signal) => new Promise<string>(() => signal.addEventListener('abort', () => (aborted = true))), 500, 'slow-call')
    const assertion = expect(slow).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(501)
    await assertion
    expect(aborted).toBe(true)
  })
})

describe('backoff and retry', () => {
  it('grows exponentially, is capped, and is jittered', () => {
    expect(backoffDelay(0, 100, 10_000, 2, () => 1)).toBe(100)
    expect(backoffDelay(3, 100, 10_000, 2, () => 1)).toBe(800)
    expect(backoffDelay(20, 100, 1_000, 2, () => 1)).toBe(1000)
    expect(backoffDelay(3, 100, 10_000, 2, () => 0)).toBe(0)
    expect(backoffDelay(3, 100, 10_000, 2, () => 0.5)).toBe(400)
  })

  it('retries failures with increasing delays then succeeds', async () => {
    const delays: number[] = []
    let calls = 0
    const result = await retry(async () => {
      calls += 1
      if (calls < 3) throw new Error('flaky')
      return 'done'
    }, { retries: 3, baseDelayMs: 100, random: () => 1, sleep: async (ms) => void delays.push(ms) })
    expect(result).toBe('done')
    expect(delays).toEqual([100, 200])
  })

  it('stops at the retry limit and rethrows the last error', async () => {
    let calls = 0
    await expect(retry(async () => { calls += 1; throw new Error(`fail ${calls}`) }, { retries: 2, sleep: noSleep })).rejects.toThrow('fail 3')
  })

  it('does not retry errors marked non-retryable, and honours a delay hint', async () => {
    let calls = 0
    await expect(retry(async () => { calls += 1; throw new Error('bad request') }, { retries: 5, sleep: noSleep, isRetryable: () => false })).rejects.toThrow('bad request')
    expect(calls).toBe(1)
    const delays: number[] = []
    let n = 0
    await retry(async () => { if (n++ === 0) throw new Error('slow down'); return 1 }, { retries: 1, sleep: async (ms) => void delays.push(ms), delayHint: () => 4000 })
    expect(delays).toEqual([4000])
  })
})

describe('circuit breaker', () => {
  it('opens after repeated failures, fails fast, then recovers via a half-open probe', async () => {
    let now = 0
    const breaker = new CircuitBreaker('svc', { failureThreshold: 3, resetTimeoutMs: 1000, now: () => now })
    const boom = async () => { throw new Error('down') }
    for (let i = 0; i < 3; i += 1) await expect(breaker.exec(boom)).rejects.toThrow('down')
    expect(breaker.getState()).toBe('open')
    await expect(breaker.exec(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError)
    now = 1001
    expect(breaker.getState()).toBe('half-open')
    await expect(breaker.exec(async () => 'recovered')).resolves.toBe('recovered')
    expect(breaker.getState()).toBe('closed')
  })

  it('reopens immediately if the half-open probe fails', async () => {
    let now = 0
    const breaker = new CircuitBreaker('svc2', { failureThreshold: 1, resetTimeoutMs: 100, now: () => now })
    await expect(breaker.exec(async () => { throw new Error('x') })).rejects.toThrow()
    now = 200
    await expect(breaker.exec(async () => { throw new Error('still down') })).rejects.toThrow('still down')
    expect(breaker.getState()).toBe('open')
  })

  it('lets only one probe through while half-open', async () => {
    let now = 0
    const breaker = new CircuitBreaker('svc3', { failureThreshold: 1, resetTimeoutMs: 10, now: () => now })
    await expect(breaker.exec(async () => { throw new Error('x') })).rejects.toThrow()
    now = 50
    let release: () => void = () => undefined
    const probe = breaker.exec(() => new Promise<string>((resolve) => (release = () => resolve('ok'))))
    await expect(breaker.exec(async () => 'second')).rejects.toBeInstanceOf(CircuitOpenError)
    release()
    await expect(probe).resolves.toBe('ok')
  })

  it('shares breakers by name', () => {
    expect(getBreaker('shared')).toBe(getBreaker('shared'))
  })
})

describe('bulkhead (backpressure)', () => {
  it('limits concurrency, queues a bounded number, then rejects', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 1 })
    let release: () => void = () => undefined
    const first = bulkhead.run(() => new Promise<string>((resolve) => (release = () => resolve('first'))))
    const second = bulkhead.run(async () => 'second')
    expect(bulkhead.stats()).toEqual({ active: 1, queued: 1 })
    await expect(bulkhead.run(async () => 'third')).rejects.toBeInstanceOf(OverloadedError)
    release()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(bulkhead.stats()).toEqual({ active: 0, queued: 0 })
  })

  it('frees the slot when work throws', async () => {
    const bulkhead = createBulkhead({ maxConcurrent: 1, maxQueue: 0 })
    await expect(bulkhead.run(async () => { throw new Error('x') })).rejects.toThrow('x')
    await expect(bulkhead.run(async () => 'fine')).resolves.toBe('fine')
  })
})

describe('chaos', () => {
  it('injects failures outside production', async () => {
    await expect(maybeInjectChaos({ env: { NODE_ENV: 'development', CHAOS_FAILURE_RATE: '1' }, random: () => 0 })).rejects.toBeInstanceOf(ChaosError)
    await expect(maybeInjectChaos({ env: { NODE_ENV: 'development', CHAOS_FAILURE_RATE: '0.5' }, random: () => 0.9 })).resolves.toBeUndefined()
  })
  it('adds latency outside production', async () => {
    const slept: number[] = []
    await maybeInjectChaos({ env: { NODE_ENV: 'test', CHAOS_LATENCY_MS: '250' }, sleep: async (ms) => void slept.push(ms) })
    expect(slept).toEqual([250])
  })
  it('is ignored in production whatever is set', async () => {
    const slept: number[] = []
    await expect(maybeInjectChaos({ env: { NODE_ENV: 'production', CHAOS_FAILURE_RATE: '1', CHAOS_LATENCY_MS: '999' }, random: () => 0, sleep: async (ms) => void slept.push(ms) })).resolves.toBeUndefined()
    expect(slept).toEqual([])
  })
})

describe('resilientFetch', () => {
  const ok = () => new Response('{"a":1}', { status: 200 })

  it('returns a good response without retrying', async () => {
    const fetchImpl = vi.fn(async () => ok())
    const response = await resilientFetch('t-ok', 'https://example.test', {}, { fetchImpl, sleep: noSleep })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries 503 then succeeds, honouring Retry-After', async () => {
    const delays: number[] = []
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(ok())
    const response = await resilientFetch('t-503', 'https://example.test', {}, { fetchImpl, sleep: async (ms) => void delays.push(ms), random: () => 0.5 })
    expect(response.status).toBe(200)
    expect(delays).toEqual([2000])
  })

  it('hands back the last retryable response when retries run out', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 429 }))
    const response = await resilientFetch('t-429', 'https://example.test', {}, { fetchImpl, sleep: noSleep, retries: 1 })
    expect(response.status).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry client errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }))
    const response = await resilientFetch('t-400', 'https://example.test', {}, { fetchImpl, sleep: noSleep })
    expect(response.status).toBe(400)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('opens the breaker after repeated server failures and then fails fast', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }))
    const options = { fetchImpl, sleep: noSleep, retries: 0, breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 } }
    await resilientFetch('t-brk', 'https://example.test', {}, options)
    await resilientFetch('t-brk', 'https://example.test', {}, options)
    await expect(resilientFetch('t-brk', 'https://example.test', {}, options)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries network errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(ok())
    const response = await resilientFetch('t-net', 'https://example.test', {}, { fetchImpl, sleep: noSleep })
    expect(response.status).toBe(200)
  })
})
