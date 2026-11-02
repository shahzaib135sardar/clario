import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { ConfigurationError } from './env'
import { getContext, logger, runWithContext } from './logger'
import { recordRequest, routeTemplate } from './metrics'
import { resolveTrace } from './tracing'
import { applySecurityHeaders, handlePreflight, isOriginAllowed } from './security'
import { registerAuditSubscribers } from './audit'
import { OverloadedError } from './resilience'

// Minimal hand-rolled helpers instead of the @vercel/node helper package —
// that package pulls in a transitive ajv/path-to-regexp/undici chain with
// known advisories. Plain node:http types plus these few helpers cover
// everything these functions need.

export type ApiRequest = IncomingMessage
export type ApiResponse = ServerResponse

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024 // 2 MB — generous for extracted text, small for everything else

export class BadRequestError extends Error {}

function parseJsonText(text: string): unknown {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BadRequestError('Request body is not valid JSON.')
  }
}

export async function readJsonBody(req: ApiRequest): Promise<unknown> {
  const declaredLength = Number(req.headers?.['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new BadRequestError('Request body is too large.')
  }

  // Vercel's Node runtime — including `vercel dev` — reads the request stream
  // itself and exposes the result as `req.body`. Iterating the stream again
  // after that returns nothing, which looks like an empty body. So use the
  // pre-read body when the platform provides one, and only fall back to
  // reading the stream directly (plain node:http, tests).
  let preRead: unknown
  try {
    preRead = (req as ApiRequest & { body?: unknown }).body
  } catch {
    throw new BadRequestError('Request body is not valid JSON.')
  }
  if (preRead !== undefined && preRead !== null) {
    if (typeof preRead === 'string') return parseJsonText(preRead)
    if (Buffer.isBuffer(preRead)) return parseJsonText(preRead.toString('utf8'))
    return preRead
  }

  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_JSON_BODY_BYTES) {
      throw new BadRequestError('Request body is too large.')
    }
    chunks.push(buf)
  }

  if (total === 0) return {}

  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new BadRequestError('Request body is not valid JSON.')
  }
}

export function sendJson(res: ApiResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function sendError(res: ApiResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

export function requireMethod(req: ApiRequest, res: ApiResponse, allowed: readonly string[]): boolean {
  const method = req.method ?? ''
  if (!allowed.includes(method)) {
    res.setHeader('Allow', allowed.join(', '))
    sendError(res, 405, `Method ${method} is not allowed here.`)
    return false
  }
  return true
}

export function getBearerToken(req: ApiRequest): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

export function getClientIp(req: ApiRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const candidate = first?.split(',')[0]?.trim()
  return candidate || req.socket.remoteAddress || 'unknown'
}

/**
 * Splits the request path into segments without relying on a platform's
 * own dynamic-route param injection (which differs between the plain
 * node:http runtime used here and higher-level framework adapters) —
 * works the same in local dev and in a deployed Vercel-style function.
 */
export function getPathSegments(req: ApiRequest): string[] {
  const url = new URL(req.url ?? '/', 'http://internal')
  return url.pathname.split('/').filter(Boolean)
}

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/

export type HandlerOptions = {
  /** Reply 504 if the handler has not started a response after this long. Env REQUEST_TIMEOUT_MS overrides the default. */
  timeoutMs?: number
}

function firstHeader(req: ApiRequest, name: string): string | undefined {
  const value = req.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function safeSetHeader(res: ApiResponse, name: string, value: string): void {
  if (typeof res.setHeader === 'function' && !res.headersSent) res.setHeader(name, value)
}

function requestTimeoutMs(options: HandlerOptions): number {
  const fromEnv = Number(process.env.REQUEST_TIMEOUT_MS)
  return options.timeoutMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_REQUEST_TIMEOUT_MS)
}

/**
 * The shared wrapper around every route.
 *
 * Reliability: an error thrown anywhere in a handler (a missing environment
 * variable, a failed network call) is turned into a JSON error instead of
 * crashing `vercel dev` or returning an opaque 500; a handler that hangs gets
 * a 504; overload from the bulkhead becomes a 503 with Retry-After.
 * Security: every response gets security headers, cross-origin writes are
 * refused, CORS preflights are answered only for trusted origins, and unknown
 * errors never leak their message or stack to the client.
 * Observability: each request gets an id (echoed as X-Request-Id), a W3C trace
 * context, one structured access-log line and request metrics.
 */
export function withErrorHandling(
  handler: (req: ApiRequest, res: ApiResponse) => Promise<void>,
  options: HandlerOptions = {},
): (req: ApiRequest, res: ApiResponse) => Promise<void> {
  return async (req, res) => {
    const startedAt = Date.now()
    const inbound = firstHeader(req, 'x-request-id')
    const requestId = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID()
    const trace = resolveTrace(firstHeader(req, 'traceparent'))
    const method = (req.method ?? 'GET').toUpperCase()
    const route = routeTemplate(req.url)

    await runWithContext({ requestId, traceId: trace.traceId, spanId: trace.spanId, ip: req.socket ? getClientIp(req) : undefined }, async () => {
      safeSetHeader(res, 'X-Request-Id', requestId)
      applySecurityHeaders(res)
      registerAuditSubscribers()

      let timer: ReturnType<typeof setTimeout> | undefined
      const execute = async (): Promise<void> => {
        try {
          if (handlePreflight(req, res)) return
          if (!isOriginAllowed(req)) {
            sendError(res, 403, 'This request was blocked because it came from another site.')
            return
          }
          await handler(req, res)
        } catch (error) {
          if (res.headersSent) {
            res.end()
            return
          }
          if (error instanceof ConfigurationError) {
            logger.error('configuration error', { message: error.message })
            sendError(res, 500, error.message)
            return
          }
          if (error instanceof BadRequestError) {
            sendError(res, 400, error.message)
            return
          }
          if (error instanceof OverloadedError) {
            res.setHeader('Retry-After', '2')
            sendError(res, 503, error.message)
            return
          }
          logger.error('unhandled error', { error })
          sendJson(res, 500, { error: 'Something went wrong. Please try again.', requestId })
        }
      }

      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), requestTimeoutMs(options))
        timer.unref?.()
      })
      const outcome = await Promise.race([execute().then(() => 'done' as const), timeout])
      if (timer) clearTimeout(timer)
      if (outcome === 'timeout' && !res.headersSent) {
        logger.error('request timed out', { route })
        res.setHeader('Retry-After', '5')
        sendJson(res, 504, { error: 'This is taking longer than expected. Please try again.', requestId })
      }

      const status = typeof res.statusCode === 'number' && res.statusCode > 0 ? res.statusCode : 200
      const durationMs = Date.now() - startedAt
      recordRequest({ method, route, status, durationMs })
      logger.info('request', { method, route, status, durationMs, userId: getContext().userId })
    })
  }
}
