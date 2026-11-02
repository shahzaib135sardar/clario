import type { IncomingMessage } from 'node:http'

// Small, dependency-free building blocks for the self-host gateway. Everything
// here is pure or takes its clock/sleep as a parameter so it can be tested exactly.

/** Backpressure: cap concurrent API requests and answer "busy" instead of queueing without bound. */
export function createInflightLimiter(max: number) {
  let active = 0
  return {
    /** Returns false when full; the caller must then reject the request. */
    tryEnter(): boolean {
      if (active >= max) return false
      active += 1
      return true
    },
    leave(): void {
      if (active > 0) active -= 1
    },
    count: () => active,
    max,
  }
}

/** Client IP, trusting X-Forwarded-For only when the server sits behind a proxy we control. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first) return first
    const real = req.headers['x-real-ip']
    const realValue = Array.isArray(real) ? real[0] : real
    if (realValue) return realValue.trim()
  }
  return req.socket?.remoteAddress ?? 'unknown'
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** Turns a limiter result into a decision. A broken limiter fails open: the API routes still enforce per-user limits. */
export function toRateDecision(result: { success: boolean; resetAt: number } | null, now: number = Date.now()): RateDecision {
  if (result === null || result.success) return { allowed: true }
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - now) / 1000)) }
}

/**
 * Waits (polling) until no requests are in flight or `drainMs` passes.
 * Used during graceful shutdown so a deploy doesn't cut off running requests.
 */
export async function waitForDrain(options: {
  inFlight: () => number
  drainMs: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<{ drained: boolean; remaining: number }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + options.drainMs
  while (options.inFlight() > 0 && now() < deadline) await sleep(options.pollMs ?? 100)
  const remaining = options.inFlight()
  return { drained: remaining === 0, remaining }
}
