// Retry helpers for the API client: exponential backoff with jitter, a
// retry policy that is safe for non-idempotent requests, and an
// Idempotency-Key generator that also works on plain-http LAN test URLs
// (where crypto.randomUUID is unavailable).

export type RetryOptions = {
  /** How many times to retry after the first attempt. */
  retries: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryOptions = { retries: 2, baseDelayMs: 400, maxDelayMs: 4000 }

/**
 * Delay before retry number `attempt` (0 = first retry): base * 2^attempt,
 * capped, then "equal jitter" — somewhere between half and all of it — so many
 * clients that failed together do not all come back at the same instant.
 */
export function backoffDelay(attempt: number, options: RetryOptions = DEFAULT_RETRY, random: () => number = Math.random): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** Math.max(0, attempt))
  return Math.round(exponential * (0.5 + random() * 0.5))
}

/** Gateway-type failures that usually clear up on their own. 4xx are never retried. */
export function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/** fetch() rejects with a TypeError when the network itself fails. */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError
}

/**
 * May this request be sent again after a failure? GET is always safe. A POST is
 * only safe when it carries an Idempotency-Key the server uses to dedupe.
 */
export function canRetryMethod(method: string, hasIdempotencyKey: boolean): boolean {
  const upper = method.toUpperCase()
  if (upper === 'GET' || upper === 'HEAD') return true
  return upper === 'POST' && hasIdempotencyKey
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs `run`, retrying when it throws something `isRetryable` accepts, waiting
 * an exponentially growing, jittered delay between attempts.
 */
export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: RetryOptions = DEFAULT_RETRY,
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt)
    } catch (error) {
      if (attempt >= options.retries || !isRetryable(error)) throw error
      await sleep(backoffDelay(attempt, options, random))
    }
  }
}

/** One key per user action, reused across that action's retries. */
export function generateIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
