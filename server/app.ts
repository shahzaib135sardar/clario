import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { loadConfig, type ServerConfig } from './config'
import { log } from './log'
import { clientIp, createInflightLimiter, toRateDecision, waitForDrain, type RateDecision } from './gateway'
import { matchRoute, ROUTES, type RouteDefinition } from './routes'
import { buildSecurityHeaders, ensureRequestId } from './security'
import { serveStatic } from './static'

export type GatewayDeps = {
  routes?: readonly RouteDefinition[]
  /** Per-IP limiter. Defaults to the shared Redis limiter; tests inject a fake. */
  rateLimiter?: (ip: string, config: ServerConfig) => Promise<{ success: boolean; resetAt: number } | null>
}

async function defaultRateLimiter(ip: string, config: ServerConfig) {
  try {
    const { checkRateLimit } = await import('../api/_lib/rateLimit')
    const { name, limit, windowSeconds } = config.rateLimit
    return await checkRateLimit(name, ip, limit, windowSeconds)
  } catch (error) {
    log('warn', 'gateway rate limiter unavailable, allowing request', { reason: error instanceof Error ? error.name : 'error' })
    return null
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

/**
 * The self-host gateway: one place that serves the built web app, forwards /api/*
 * to the same handlers Vercel runs, and applies the edge policies (request ids,
 * security headers, rate limit, backpressure, health endpoints, graceful shutdown).
 */
export function createGateway(config: ServerConfig = loadConfig(), deps: GatewayDeps = {}) {
  const routes = deps.routes ?? ROUTES
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter
  const limiter = createInflightLimiter(config.maxInFlight)
  const handlerCache = new Map<string, Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>>>()
  let shuttingDown = false

  const loadHandler = (route: RouteDefinition) => {
    let cached = handlerCache.get(route.pattern)
    if (!cached) {
      cached = route.load().then((module) => module.default)
      cached.catch(() => handlerCache.delete(route.pattern)) // retry the import next time if it failed
      handlerCache.set(route.pattern, cached)
    }
    return cached
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    const requestId = ensureRequestId(req.headers['x-request-id'])
    const forwardedProto = req.headers['x-forwarded-proto']
    const https = config.trustProxy && (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) === 'https'
    res.setHeader('X-Request-Id', requestId)
    for (const [name, value] of Object.entries(buildSecurityHeaders(https))) res.setHeader(name, value)
    if (shuttingDown) res.setHeader('Connection', 'close')

    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://gateway')
    } catch {
      sendJson(res, 400, { error: 'Bad request.' })
      return
    }
    const pathname = url.pathname
    res.on('finish', () => {
      log('info', 'request', { requestId, method: req.method, path: pathname.startsWith('/api/') ? pathname.replace(/[0-9a-f-]{36}/gi, ':id') : '(static)', status: res.statusCode, ms: Date.now() - startedAt })
    })

    // Liveness: "the process is up". Readiness: "send me traffic" (false while draining).
    if (pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok', inFlight: limiter.count() })
      return
    }

    const apiMatch = matchRoute(pathname, routes)
    const readyMatch = pathname === '/readyz' ? matchRoute('/api/internal/ready', routes) : null
    if (readyMatch && shuttingDown) {
      sendJson(res, 503, { status: 'draining' })
      return
    }

    const match = readyMatch ?? apiMatch
    if (!match) {
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Not found.' })
        return
      }
      await serveStatic(req, res, config.staticDir, pathname)
      return
    }

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      sendJson(res, 413, { error: 'Request body is too large.' })
      return
    }

    if (!limiter.tryEnter()) {
      sendJson(res, 503, { error: 'The server is busy. Please try again in a moment.' }, { 'Retry-After': '1' })
      return
    }
    try {
      if (!readyMatch && match.route.pattern !== '/api/internal/:task') {
        const decision: RateDecision = toRateDecision(await rateLimiter(clientIp(req, config.trustProxy), config))
        if (!decision.allowed) {
          sendJson(res, 429, { error: 'Too many requests. Please slow down and try again shortly.' }, { 'Retry-After': String(decision.retryAfterSeconds) })
          return
        }
      }
      // Route aliases (/api/v1/..., /readyz) are rewritten so the handler sees its canonical path.
      req.url = readyMatch ? '/api/internal/ready' : `${pathname.replace(/^\/api\/v1(\/|$)/, '/api$1')}${url.search}`
      const handler = await loadHandler(match.route)
      await handler(req, res)
    } catch (error) {
      log('error', 'gateway handler failure', { requestId, reason: error instanceof Error ? error.name : 'error' })
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong. Please try again.', requestId })
      else res.end()
    } finally {
      limiter.leave()
    }
  }

  function listen(): Server {
    const server = createServer((req, res) => {
      void handle(req, res).catch((error) => {
        log('error', 'unexpected gateway error', { reason: error instanceof Error ? error.name : 'error' })
        if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' })
        else res.end()
      })
    })
    // Longer than a typical proxy's idle timeout, so the proxy never reuses a socket we already closed.
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 66_000
    server.requestTimeout = config.requestTimeoutMs
    server.listen(config.port, config.host)
    return server
  }

  /** Stop taking new connections, let running requests finish (up to the drain window), then close. */
  async function shutdown(server: Server): Promise<{ drained: boolean; remaining: number }> {
    shuttingDown = true
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    const outcome = await waitForDrain({ inFlight: limiter.count, drainMs: config.shutdownDrainMs })
    server.closeIdleConnections?.()
    if (!outcome.drained) server.closeAllConnections?.()
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1000))])
    return outcome
  }

  return { handle, listen, shutdown, limiter, isShuttingDown: () => shuttingDown }
}
