import { randomUUID } from 'node:crypto'

// The same policy is in vercel.json; server/__tests__/security.test.ts keeps the
// two from drifting apart. Every source is explained in docs/OPERATIONS.md.
export const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.r2.cloudflarestorage.com",
  "worker-src 'self' blob:",
  'frame-src https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
]

export const UPGRADE_INSECURE_REQUESTS = 'upgrade-insecure-requests'
export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join('; ')

export const HSTS_VALUE = 'max-age=63072000; includeSubDomains'

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
}

/**
 * Headers for one response. `https` is true when the client reached us over
 * TLS (directly or via a trusted proxy): HSTS and upgrade-insecure-requests
 * are only meaningful then, and would break plain-http local testing.
 */
export function buildSecurityHeaders(https: boolean): Record<string, string> {
  const csp = https ? `${CONTENT_SECURITY_POLICY}; ${UPGRADE_INSECURE_REQUESTS}` : CONTENT_SECURITY_POLICY
  return {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': csp,
    ...(https ? { 'Strict-Transport-Security': HSTS_VALUE } : {}),
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/

/** Keeps a well-formed inbound X-Request-Id (so traces line up across proxies), else makes one. */
export function ensureRequestId(incoming: string | string[] | undefined): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID()
}

export type OriginVerdict = 'none' | 'same-origin' | 'trusted' | 'denied'

/**
 * Decides what to do with a browser's Origin header. Same-origin and the
 * explicit allow-list pass; everything else (including the literal "null")
 * is denied. A missing Origin is a non-browser client or a same-origin GET.
 */
export function evaluateOrigin(input: {
  origin: string | undefined
  host: string | undefined
  forwardedHost?: string | undefined
  trusted: readonly string[]
}): OriginVerdict {
  const { origin } = input
  if (!origin) return 'none'
  if (origin === 'null') return 'denied'
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return 'denied'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'denied'
  const normalized = parsed.origin
  if (input.trusted.includes(normalized)) return 'trusted'
  const hosts = [input.host, input.forwardedHost].filter((value): value is string => Boolean(value))
  if (hosts.some((host) => host.toLowerCase() === parsed.host.toLowerCase())) return 'same-origin'
  return 'denied'
}
