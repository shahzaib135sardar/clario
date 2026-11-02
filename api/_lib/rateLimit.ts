import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { getUpstashConfig } from './env'

// A shared Redis-backed store — never in-memory counters, which don't
// persist across separate serverless function instances and would let a
// caller simply retry until a fresh instance resets their count to zero.

let cachedRedis: Redis | null = null

export function getRedis(): Redis {
  if (cachedRedis) return cachedRedis
  const { url, token } = getUpstashConfig()
  cachedRedis = new Redis({ url, token })
  return cachedRedis
}

const limiters = new Map<string, Ratelimit>()

function getLimiter(name: string, limit: number, windowSeconds: number): Ratelimit {
  const cacheKey = `${name}:${limit}:${windowSeconds}`
  const existing = limiters.get(cacheKey)
  if (existing) return existing
  const limiter = new Ratelimit({
    redis: getRedis(),
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    prefix: `clario:ratelimit:${name}`,
  })
  limiters.set(cacheKey, limiter)
  return limiter
}

export type RateLimitResult = { success: boolean; remaining: number; resetAt: number }

export async function checkRateLimit(
  name: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const limiter = getLimiter(name, limit, windowSeconds)
  const result = await limiter.limit(identifier)
  return { success: result.success, remaining: result.remaining, resetAt: result.reset }
}

// Per-route budgets. Keyed by user for the primary guard, and loosely by IP
// as a secondary guard against one person cycling through accounts.
export const RATE_LIMITS = {
  documentCreatePerUser: { name: 'document-create-user', limit: 20, windowSeconds: 3600 },
  documentCreatePerIp: { name: 'document-create-ip', limit: 60, windowSeconds: 3600 },
  documentConfirmPerUser: { name: 'document-confirm-user', limit: 60, windowSeconds: 3600 },
  documentDeletePerUser: { name: 'document-delete-user', limit: 30, windowSeconds: 3600 },
  documentListPerUser: { name: 'document-list-user', limit: 120, windowSeconds: 3600 },

  chatSendPerUser: { name: 'chat-send-user', limit: 40, windowSeconds: 3600 },
  chatListPerUser: { name: 'chat-list-user', limit: 120, windowSeconds: 3600 },

  summaryGeneratePerUser: { name: 'summary-generate-user', limit: 20, windowSeconds: 3600 },
  chartGeneratePerUser: { name: 'chart-generate-user', limit: 20, windowSeconds: 3600 },
  planGeneratePerUser: { name: 'plan-generate-user', limit: 20, windowSeconds: 3600 },
  artifactGetPerUser: { name: 'artifact-get-user', limit: 120, windowSeconds: 3600 },

  pptxGeneratePerUser: { name: 'pptx-generate-user', limit: 10, windowSeconds: 3600 },
  pptxDownloadPerUser: { name: 'pptx-download-user', limit: 60, windowSeconds: 3600 },

  resumeAnalyzePerUser: { name: 'resume-analyze-user', limit: 10, windowSeconds: 3600 },
  jobsRefreshPerUser: { name: 'jobs-refresh-user', limit: 10, windowSeconds: 3600 },

  usageGetPerUser: { name: 'usage-get-user', limit: 120, windowSeconds: 3600 },
} as const
