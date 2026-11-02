import { createHmac, timingSafeEqual } from 'node:crypto'

// Verifies signed webhooks (the receiving side). Header format:
//   X-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">
// Checks: signature (constant-time), timestamp within tolerance (stops replays of
// old captures) and an optional "seen before" hook (stops replays inside the window).
// There is no webhook route in Clario yet; this is the building block for the first one.

export const DEFAULT_TOLERANCE_SECONDS = 300

export function signPayload(secret: string, body: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${digest}`
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' | 'replayed' }

export type VerifyOptions = {
  toleranceSeconds?: number
  nowSeconds?: number
  /** Return true if this signature was already accepted before (e.g. Redis SET NX failed). */
  hasSeen?: (signature: string) => boolean | Promise<boolean>
}

export async function verifyWebhook(secret: string, rawBody: string, header: string | undefined | null, options: VerifyOptions = {}): Promise<VerifyResult> {
  if (!secret || !header) return { ok: false, reason: 'malformed' }
  const parts = Object.fromEntries(header.split(',').map((piece) => piece.trim().split('=', 2) as [string, string]))
  const timestamp = Number(parts.t)
  const provided = parts.v1
  if (!Number.isInteger(timestamp) || !provided || !/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: 'malformed' }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return { ok: false, reason: 'stale' }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  const given = Buffer.from(provided, 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'mismatch' }

  if (options.hasSeen && (await options.hasSeen(provided))) return { ok: false, reason: 'replayed' }
  return { ok: true, timestamp }
}
