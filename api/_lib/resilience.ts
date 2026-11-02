import { outboundTraceHeaders } from './tracing'
import { logger } from './logger'
import { incCounter } from './metrics'

// Reliability building blocks for calls to other services (AI providers, job
// boards): timeouts, retries with exponential backoff and jitter, a circuit
// breaker, and a concurrency limiter that pushes back instead of queueing
// without bound. Time and randomness are injectable so the tests are exact.

export class TimeoutError extends Error {}
export class OverloadedError extends Error {}
export class CircuitOpenError extends Error {}
export class ChaosError extends Error {}

type Sleep = (ms: number) => Promise<void>
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- Timeout ---------------------------------------------------------------------------

/**
 * Runs `fn` with an AbortSignal that fires after `ms`. The returned promise
 * rejects with TimeoutError at that point even if `fn` ignores the signal.
 */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, label = 'operation'): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(`${label} timed out after ${ms} ms`)
      controller.abort(error)
      reject(error)
    }, ms)
  })
  try {
    return await Promise.race([fn(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// --- Retry with exponential backoff and full jitter -------------------------------------

/** Full jitter: a random delay between 0 and min(max, base * factor^attempt). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, factor = 2, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * factor ** attempt)
  return Math.floor(random() * ceiling)
}

export type RetryOptions = {
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  factor?: number
  isRetryable?: (error: unknown) => boolean
  /** A delay the server asked for (Retry-After) wins over the computed backoff. */
  delayHint?: (error: unknown) => number | undefined
  sleep?: Sleep
  random?: () => number
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    retries = 2,
    baseDelayMs = 200,
    maxDelayMs = 5000,
    factor = 2,
    isRetryable = () => true,
    delayHint,
    sleep = defaultSleep,
    random = Math.random,
    onRetry,
  } = options

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error
      const hinted = delayHint?.(error)
      const delay = hinted !== undefined ? Math.min(hinted, maxDelayMs) : backoffDelay(attempt, baseDelayMs, maxDelayMs, factor, random)
      onRetry?.(error, attempt + 1, delay)
      await sleep(delay)
    }
  }
}

// --- Circuit breaker --------------------------------------------------------------------

export type BreakerState = 'closed' | 'open' | 'half-open'

export type BreakerOptions = {
  failureThreshold?: number
  resetTimeoutMs?: number
  now?: () => number
}

export class CircuitBreaker {
  private state: BreakerState = 'closed'
  private failures = 0
  private openedAt = 0
  private probeInFlight = false
  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly now: () => number

  constructor(
    readonly name: string,
    options: BreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  getState(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.resetTimeoutMs) return 'half-open'
    return this.state
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState()
    if (state === 'open') throw new CircuitOpenError(`${this.name} is temporarily unavailable`)
    if (state === 'half-open') {
      // Let exactly one trial request through; everyone else keeps failing fast.
      if (this.probeInFlight) throw new CircuitOpenError(`${this.name} is temporarily unavailable`)
      this.probeInFlight = true
      this.state = 'half-open'
    }
    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    } finally {
      this.probeInFlight = false
    }
  }

  private onSuccess(): void {
    this.failures = 0
    this.state = 'closed'
  }

  private onFailure(): void {
    this.failures += 1
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      if (this.state !== 'open') {
        logger.warn('circuit opened', { breaker: this.name, failures: this.failures })
        incCounter('circuit_breaker_open_total', { breaker: this.name })
      }
      this.state = 'open'
      this.openedAt = this.now()
    }
  }
}

const breakers = new Map<string, CircuitBreaker>()

export function getBreaker(name: string, options?: BreakerOptions): CircuitBreaker {
  let breaker = breakers.get(name)
  if (!breaker) breakers.set(name, (breaker = new CircuitBreaker(name, options)))
  return breaker
}

export function resetBreakers(): void {
  breakers.clear()
}

// --- Bulkhead / backpressure -------------------------------------------------------------

export type BulkheadOptions = { maxConcurrent: number; maxQueue: number }

/**
 * Caps how many calls run at once. Extra callers wait in a bounded queue; once
 * the queue is full they are rejected immediately (OverloadedError) so load
 * shows up as a fast, honest "busy" instead of a growing pile of waiters.
 */
export function createBulkhead({ maxConcurrent, maxQueue }: BulkheadOptions) {
  let active = 0
  const waiting: Array<() => void> = []

  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < maxConcurrent) {
        active += 1
      } else if (waiting.length < maxQueue) {
        await new Promise<void>((resolve) => waiting.push(resolve)) // slot is handed over without freeing it
      } else {
        throw new OverloadedError('Too many requests are in progress. Please try again in a moment.')
      }
      try {
        return await fn()
      } finally {
        release()
      }
    },
    stats: () => ({ active, queued: waiting.length }),
  }
}

// --- Chaos (fault injection) --------------------------------------------------------------

export type ChaosOptions = {
  env?: NodeJS.ProcessEnv
  random?: () => number
  sleep?: Sleep
}

/**
 * Deliberately slows or fails outbound calls so the retry/breaker/fallback
 * paths can be exercised on purpose. Controlled by CHAOS_LATENCY_MS and
 * CHAOS_FAILURE_RATE (0–1). Does nothing in production, whatever is set.
 */
export async function maybeInjectChaos(options: ChaosOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  if (env.NODE_ENV === 'production') return
  const latency = Number(env.CHAOS_LATENCY_MS)
  const failureRate = Number(env.CHAOS_FAILURE_RATE)
  if (Number.isFinite(latency) && latency > 0) await (options.sleep ?? defaultSleep)(Math.min(latency, 30_000))
  if (Number.isFinite(failureRate) && failureRate > 0 && (options.random ?? Math.random)() < failureRate) {
    throw new ChaosError('Injected failure (chaos testing)')
  }
}

// --- resilientFetch ----------------------------------------------------------------------

export type ResilientFetchOptions = {
  timeoutMs?: number
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Response statuses worth retrying. Defaults to throttling and transient server errors. */
  retryOnStatus?: readonly number[]
  /** A timed-out attempt is not retried by default, so a slow service cannot multiply the wait. */
  retryOnTimeout?: boolean
  breaker?: BreakerOptions
  fetchImpl?: typeof fetch
  sleep?: Sleep
  random?: () => number
}

class RetryableResponse extends Error {
  constructor(readonly response: Response) {
    super(`retryable status ${response.status}`)
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/**
 * fetch with a per-attempt timeout, bounded retries with backoff (honouring
 * Retry-After), a per-name circuit breaker, trace propagation and optional
 * chaos injection. If retries run out on a retryable status, the last
 * response is returned so callers can read its body and report it.
 */
export async function resilientFetch(
  name: string,
  url: string | URL,
  init: RequestInit = {},
  options: ResilientFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 15_000,
    retries = 2,
    baseDelayMs = 300,
    maxDelayMs = 5_000,
    retryOnStatus = [429, 500, 502, 503, 504],
    retryOnTimeout = false,
    fetchImpl,
    sleep,
    random,
  } = options
  const breaker = getBreaker(name, options.breaker)

  const attempt = async (): Promise<Response> => {
    await maybeInjectChaos({ sleep, random })
    const response = await withTimeout(
      (signal) =>
        (fetchImpl ?? globalThis.fetch)(url, {
          ...init,
          signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
          headers: { ...outboundTraceHeaders(), ...(init.headers as Record<string, string> | undefined) },
        }),
      timeoutMs,
      name,
    )
    if (retryOnStatus.includes(response.status)) throw new RetryableResponse(response)
    return response
  }

  try {
    return await breaker.exec(async () => {
      try {
        return await retry(attempt, {
          retries,
          baseDelayMs,
          maxDelayMs,
          sleep,
          random,
          isRetryable: (error) => !(error instanceof TimeoutError) || retryOnTimeout,
          delayHint: (error) => (error instanceof RetryableResponse ? retryAfterMs(error.response) : undefined),
          onRetry: (error, n, delay) => {
            incCounter('outbound_retries_total', { target: name })
            logger.warn('outbound retry', {
              target: name,
              attempt: n,
              delayMs: delay,
              reason: error instanceof RetryableResponse ? `status ${error.response.status}` : error instanceof Error ? error.name : 'error',
            })
          },
        })
      } catch (error) {
        // Throttling (429) is the provider doing its job, not an outage: hand the response
        // back without counting it against the breaker. Server errors do count.
        if (error instanceof RetryableResponse) {
          if (error.response.status >= 500) throw error
          return error.response
        }
        throw error
      }
    })
  } catch (error) {
    if (error instanceof RetryableResponse) return error.response
    throw error
  }
}
