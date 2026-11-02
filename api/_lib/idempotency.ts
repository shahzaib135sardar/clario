import { createHash } from 'node:crypto'
import { getRedis } from './rateLimit'
import { sendError, getPathSegments, type ApiRequest, type ApiResponse } from './http'
import { logger } from './logger'

// Idempotency keys: a client that retries a POST (flaky mobile network, double
// tap) sends the same `Idempotency-Key`, and the server runs the work once.
//   1st request  -> takes a short lock, runs, stores the 2xx response for 24 h
//   duplicate    -> while the first is running: 409 + Retry-After
//   replay       -> after it finished: the stored response, `Idempotent-Replay: true`
// A non-2xx outcome releases the lock so the client may try again. Keys are
// scoped per user + method + path, so one user's key can never replay another's.
// If Redis is unavailable this fails OPEN: idempotency is a convenience, not a security control.

export const IDEMPOTENCY_HEADER = 'idempotency-key'
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const LOCK_TTL_SECONDS = 120
const RESULT_TTL_SECONDS = 24 * 60 * 60
const MAX_STORED_BYTES = 256 * 1024

export type StoredResponse = { status: number; body: string; contentType: string }

export interface IdempotencyStore {
  /** Claim the key. true = we own it; false = someone else holds or finished it. */
  claim(key: string, ttlSeconds: number): Promise<boolean>
  get(key: string): Promise<StoredResponse | 'pending' | null>
  save(key: string, value: StoredResponse, ttlSeconds: number): Promise<void>
  release(key: string): Promise<void>
}

const PENDING = '__pending__'

export function redisIdempotencyStore(): IdempotencyStore {
  const redis = getRedis()
  return {
    async claim(key, ttl) {
      return (await redis.set(key, PENDING, { nx: true, ex: ttl })) === 'OK'
    },
    async get(key) {
      const value = await redis.get<unknown>(key)
      if (value === null || value === undefined) return null
      if (value === PENDING) return 'pending'
      return typeof value === 'object' ? (value as StoredResponse) : null
    },
    async save(key, value, ttl) {
      await redis.set(key, value, { ex: ttl })
    },
    async release(key) {
      await redis.del(key)
    },
  }
}

export function idempotencyStorageKey(userId: string, method: string, path: string, clientKey: string): string {
  const digest = createHash('sha256').update(`${userId}\n${method}\n${path}\n${clientKey}`).digest('hex')
  return `clario:idem:${digest}`
}

export function readIdempotencyKey(req: ApiRequest): string | null | 'invalid' {
  const raw = req.headers[IDEMPOTENCY_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === '') return null
  return KEY_PATTERN.test(value) ? value : 'invalid'
}

/**
 * Call right after authentication in a POST handler:
 *   if (!(await beginIdempotent(req, res, user.id))) return
 * Returns false when it already answered (replay, in-flight duplicate, bad key).
 */
export async function beginIdempotent(
  req: ApiRequest,
  res: ApiResponse,
  userId: string,
  storeFactory: () => IdempotencyStore = redisIdempotencyStore,
): Promise<boolean> {
  const clientKey = readIdempotencyKey(req)
  if (clientKey === null) return true
  if (clientKey === 'invalid') {
    sendError(res, 400, 'Idempotency-Key must be 8-128 characters: letters, digits, "-" or "_".')
    return false
  }

  let store: IdempotencyStore
  let key: string
  try {
    store = storeFactory()
    key = idempotencyStorageKey(userId, req.method ?? 'POST', getPathSegments(req).join('/'), clientKey)
    if (!(await store.claim(key, LOCK_TTL_SECONDS))) {
      const existing = await store.get(key)
      if (existing && existing !== 'pending') {
        res.setHeader('Idempotent-Replay', 'true')
        res.writeHead(existing.status, { 'Content-Type': existing.contentType, 'Cache-Control': 'no-store' })
        res.end(existing.body)
        return false
      }
      res.setHeader('Retry-After', '2')
      sendError(res, 409, 'This request is already being processed. Try again in a moment.')
      return false
    }
  } catch (error) {
    logger.warn('idempotency unavailable, continuing without it', { reason: error instanceof Error ? error.message : 'unknown' })
    return true
  }

  // We own the key: capture the outcome as the handler writes it.
  const chunks: Buffer[] = []
  let size = 0
  let status = 200
  let contentType = 'application/json; charset=utf-8'
  const originalWriteHead = res.writeHead.bind(res)
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)

  const capture = (chunk: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buf.length
    if (size <= MAX_STORED_BYTES) chunks.push(buf)
  }

  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code
    const headers = rest.find((entry) => entry && typeof entry === 'object') as Record<string, unknown> | undefined
    const ct = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    if (typeof ct === 'string') contentType = ct
    return (originalWriteHead as (...args: unknown[]) => ServerResponseLike)(code, ...rest)
  }) as typeof res.writeHead
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    capture(chunk)
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof res.write
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    capture(chunk)
    const finish = async () => {
      try {
        if (status >= 200 && status < 300 && size <= MAX_STORED_BYTES) {
          await store.save(key, { status, contentType, body: Buffer.concat(chunks).toString('utf8') }, RESULT_TTL_SECONDS)
        } else {
          await store.release(key)
        }
      } catch (error) {
        logger.warn('idempotency save failed', { reason: error instanceof Error ? error.message : 'unknown' })
      }
    }
    void finish()
    return (originalEnd as (...args: unknown[]) => ApiResponse)(chunk, ...rest)
  }) as typeof res.end

  return true
}

type ServerResponseLike = ApiResponse
