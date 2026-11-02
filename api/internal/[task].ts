import {
  withErrorHandling,
  getPathSegments,
  requireMethod,
  sendError,
  sendJson,
  type ApiRequest,
  type ApiResponse,
} from '../_lib/http'
import { getRedis } from '../_lib/rateLimit'
import { getSupabaseConfig, getUpstashConfig } from '../_lib/env'
import { renderPrometheus, sloReport } from '../_lib/metrics'
import { runAsLeader } from '../_lib/locks'
import { loadAllFeeds, JOB_SOURCES } from '../_lib/jobSources'
import { withTimeout } from '../_lib/resilience'
import { logger } from '../_lib/logger'
import { bearerMatches } from '../_lib/security'

// One function for the operational endpoints (kept to a single file because Vercel's
// Hobby plan limits how many functions a project may have):
//   GET /api/internal/health      liveness  — the process is up
//   GET /api/internal/ready       readiness — configuration present, Redis and Supabase reachable
//   GET /api/internal/metrics     Prometheus text + SLO report (needs METRICS_TOKEN)
//   GET /api/internal/warm-feeds  scheduled: refresh the job-board caches (needs CRON_SECRET)

const startedAt = Date.now()
const CHECK_TIMEOUT_MS = 2000

type Check = { name: string; ok: boolean; detail?: string }

async function runCheck(name: string, fn: () => Promise<void>): Promise<Check> {
  try {
    await withTimeout(fn, CHECK_TIMEOUT_MS, name)
    return { name, ok: true }
  } catch (error) {
    // Names the failing component and the kind of problem, never a secret.
    return { name, ok: false, detail: error instanceof Error ? error.name : 'error' }
  }
}

async function readiness(): Promise<Check[]> {
  return Promise.all([
    runCheck('config', async () => {
      getSupabaseConfig()
      getUpstashConfig()
    }),
    runCheck('redis', async () => {
      await getRedis().ping()
    }),
    runCheck('supabase', async () => {
      const { url } = getSupabaseConfig()
      const response = await fetch(`${new URL('/auth/v1/health', url)}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
      if (response.status >= 500) throw new Error('unhealthy')
    }),
  ])
}

async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (!requireMethod(req, res, ['GET', 'POST'])) return
  const segments = getPathSegments(req)
  const task = segments[segments.indexOf('internal') + 1]
  const auth = req.headers.authorization

  switch (task) {
    case 'health':
      sendJson(res, 200, { status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) })
      return

    case 'ready': {
      const checks = await readiness()
      const ready = checks.every((check) => check.ok)
      sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks })
      return
    }

    case 'metrics': {
      if (!process.env.METRICS_TOKEN) return sendError(res, 404, 'Not found.')
      if (!bearerMatches(auth, process.env.METRICS_TOKEN)) return sendError(res, 401, 'Unauthorized.')
      const wantsJson = (req.url ?? '').includes('format=json')
      if (wantsJson) return sendJson(res, 200, sloReport())
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(renderPrometheus())
      return
    }

    case 'warm-feeds': {
      if (!process.env.CRON_SECRET) return sendError(res, 404, 'Not found.')
      if (!bearerMatches(auth, process.env.CRON_SECRET)) return sendError(res, 401, 'Unauthorized.')
      const outcome = await runAsLeader('warm-feeds', 5 * 60_000, () => loadAllFeeds({ force: true }))
      if (!outcome.leader) return sendJson(res, 200, { status: 'skipped', reason: 'another instance is already refreshing' })
      const sources = (outcome.value ?? []).map((feed) => ({ source: feed.source, label: JOB_SOURCES[feed.source].label, status: feed.status, count: feed.jobs.length }))
      logger.info('feeds warmed', { sources })
      sendJson(res, 200, { status: 'ok', sources })
      return
    }

    default:
      sendError(res, 404, 'Not found.')
  }
}

export default withErrorHandling(handler)
