import { timingSafeEqual } from 'node:crypto'
import type { ApiRequest, ApiResponse } from './http'

// Defence-in-depth for the API. Clario authenticates with a bearer token in the
// Authorization header (not cookies), so classic CSRF doesn't apply; browsers
// also never attach that header cross-site on their own. These checks still
// reject obviously cross-origin state-changing requests, and keep CORS closed.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function trustedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, '').toLowerCase())
    .filter(Boolean)
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** True when the request may proceed. No Origin header (non-browser clients, same-origin GETs) is allowed. */
export function isOriginAllowed(req: Pick<ApiRequest, 'method' | 'headers'>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())) return true
  const origin = headerValue(req.headers.origin)
  if (!origin) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  const normalized = parsed.origin.toLowerCase()
  if (trustedOrigins(env).includes(normalized)) return true
  const host = (headerValue(req.headers['x-forwarded-host']) ?? headerValue(req.headers.host) ?? '').toLowerCase()
  return host !== '' && parsed.host.toLowerCase() === host
}

export function applySecurityHeaders(res: ApiResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

/**
 * Handles a CORS preflight. Only trusted origins (TRUSTED_ORIGINS) are answered; everything
 * else gets 204 with no CORS headers, so the browser blocks it. Returns true if it replied.
 */
export function handlePreflight(req: ApiRequest, res: ApiResponse, env: NodeJS.ProcessEnv = process.env): boolean {
  if (req.method !== 'OPTIONS') return false
  const origin = headerValue(req.headers.origin)?.replace(/\/$/, '').toLowerCase()
  if (origin && trustedOrigins(env).includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Request-Id')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  res.writeHead(204)
  res.end()
  return true
}

/** Constant-time check of `Authorization: Bearer <secret>` (for the metrics and cron endpoints). */
export function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(secret)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
