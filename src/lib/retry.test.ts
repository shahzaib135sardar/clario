import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RETRY,
  backoffDelay,
  canRetryMethod,
  generateIdempotencyKey,
  isNetworkError,
  isRetryableStatus,
  withRetry,
} from './retry'

describe('backoffDelay', () => {
  it('doubles each attempt, within the jitter band', () => {
    // random()=0 -> half of the exponential value; random()=1 -> all of it
    expect(backoffDelay(0, DEFAULT_RETRY, () => 0)).toBe(200)
    expect(backoffDelay(0, DEFAULT_RETRY, () => 1)).toBe(400)
    expect(backoffDelay(1, DEFAULT_RETRY, () => 1)).toBe(800)
    expect(backoffDelay(2, DEFAULT_RETRY, () => 1)).toBe(1600)
  })

  it('is capped at maxDelayMs', () => {
    expect(backoffDelay(20, DEFAULT_RETRY, () => 1)).toBe(DEFAULT_RETRY.maxDelayMs)
  })

  it('always stays inside [exp/2, exp] for real random values', () => {
    for (let i = 0; i < 200; i += 1) {
      const delay = backoffDelay(1)
      expect(delay).toBeGreaterThanOrEqual(400)
      expect(delay).toBeLessThanOrEqual(800)
    }
  })
})

describe('retry policy', () => {
  it('retries only gateway-type statuses, never 4xx', () => {
    expect([502, 503, 504].every(isRetryableStatus)).toBe(true)
    expect([400, 401, 403, 404, 409, 422, 429, 500].some(isRetryableStatus)).toBe(false)
  })

  it('treats a TypeError (fetch network failure) as retryable, not other errors', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new Error('nope'))).toBe(false)
  })

  it('allows GET always and POST only with an idempotency key', () => {
    expect(canRetryMethod('GET', false)).toBe(true)
    expect(canRetryMethod('post', true)).toBe(true)
    expect(canRetryMethod('POST', false)).toBe(false)
    expect(canRetryMethod('DELETE', true)).toBe(false)
  })
})

describe('withRetry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const retryable = (error: unknown) => error instanceof TypeError

  it('returns immediately on success', async () => {
    const run = vi.fn().mockResolvedValue('ok')
    await expect(withRetry(run, retryable)).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('waits with growing delays between attempts, then succeeds', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new TypeError('x'))
      .mockRejectedValueOnce(new TypeError('x'))
      .mockResolvedValue('done')
    const promise = withRetry(run, retryable, DEFAULT_RETRY, () => 1)

    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(399)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1) // 400 ms first delay
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(799)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1) // 800 ms second delay
    await expect(promise).resolves.toBe('done')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('gives up after the configured number of retries and rethrows', async () => {
    const run = vi.fn().mockRejectedValue(new TypeError('still down'))
    const promise = withRetry(run, retryable, { retries: 2, baseDelayMs: 10, maxDelayMs: 100 }, () => 1)
    const assertion = expect(promise).rejects.toThrow('still down')
    await vi.runAllTimersAsync()
    await assertion
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('does not retry errors the predicate rejects', async () => {
    const run = vi.fn().mockRejectedValue(new Error('bad request'))
    await expect(withRetry(run, retryable)).rejects.toThrow('bad request')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('passes the attempt number to the runner', async () => {
    const run = vi.fn().mockRejectedValueOnce(new TypeError('x')).mockResolvedValue('ok')
    const promise = withRetry(run, retryable, { retries: 1, baseDelayMs: 1, maxDelayMs: 1 }, () => 0)
    await vi.runAllTimersAsync()
    await promise
    expect(run.mock.calls.map((call) => call[0])).toEqual([0, 1])
  })
})

describe('generateIdempotencyKey', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('produces distinct keys', () => {
    expect(generateIdempotencyKey()).not.toBe(generateIdempotencyKey())
  })

  it('still works where crypto.randomUUID is missing (plain-http test URLs)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) })
    expect(generateIdempotencyKey()).toBe('07'.repeat(16))
  })

  it('falls back to Math.random when crypto is absent entirely', () => {
    vi.stubGlobal('crypto', undefined)
    expect(generateIdempotencyKey()).toMatch(/^[0-9a-f]{32}$/)
  })
})
