// Reads the self-host server's settings from environment variables.
// Nothing here is secret: ports, limits and origins only.

export type ServerConfig = {
  port: number
  host: string
  staticDir: string
  /** Trust X-Forwarded-* headers (set true only when behind nginx / an ingress). */
  trustProxy: boolean
  maxBodyBytes: number
  requestTimeoutMs: number
  maxInFlight: number
  shutdownDrainMs: number
  rateLimit: { name: string; limit: number; windowSeconds: number }
  /** Extra browser origins allowed to call the API (same-origin is always allowed). */
  trustedOrigins: string[]
}

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: readInt(env.PORT, 8080, 0, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    staticDir: env.STATIC_DIR?.trim() || 'dist',
    trustProxy: readBool(env.TRUST_PROXY, false),
    // The API's own JSON limit is 2 MB; leave a little headroom for the envelope.
    maxBodyBytes: readInt(env.MAX_BODY_BYTES, 2_621_440, 1024, 50 * 1024 * 1024),
    requestTimeoutMs: readInt(env.REQUEST_TIMEOUT_MS, 60_000, 1000, 600_000),
    maxInFlight: readInt(env.MAX_IN_FLIGHT, 100, 1, 10_000),
    shutdownDrainMs: readInt(env.SHUTDOWN_DRAIN_MS, 25_000, 0, 120_000),
    rateLimit: {
      name: 'gateway-ip',
      limit: readInt(env.GATEWAY_RATE_LIMIT_PER_MINUTE, 300, 1, 100_000),
      windowSeconds: 60,
    },
    trustedOrigins: (env.TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean),
  }
}
