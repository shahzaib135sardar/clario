import { AsyncLocalStorage } from 'node:async_hooks'

// Structured (JSON-lines) logging with a per-request context. Every line is
// one JSON object, so log platforms (Vercel, Loki, CloudWatch, ...) can filter
// on fields instead of parsing prose. Secrets are redacted before anything is
// written: a log line must be safe to paste into a support ticket.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = {
  requestId?: string
  traceId?: string
  spanId?: string
  userId?: string
  ip?: string
}

const storage = new AsyncLocalStorage<LogContext>()

/** Runs `fn` with a request context that every log line inside it inherits. */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn)
}

export function getContext(): LogContext {
  return storage.getStore() ?? {}
}

/** Adds a field (for example the user id once auth has finished) to the active context. */
export function setContextValue<K extends keyof LogContext>(key: K, value: LogContext[K]): void {
  const store = storage.getStore()
  if (store) store[key] = value
}

const SENSITIVE_KEY = /authorization|token|secret|password|passwd|api[-_]?key|apikey|cookie|credential|access[-_]?key|private[-_]?key|jwt|bearer|signature/i
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const KEY_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,})/g
const MAX_STRING = 2000
const MAX_DEPTH = 5

export const REDACTED = '[REDACTED]'

export function redactString(value: string): string {
  const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  return clipped.replace(BEARER_PATTERN, `Bearer ${REDACTED}`).replace(JWT_PATTERN, REDACTED).replace(KEY_PATTERN, REDACTED)
}

/** Deep-copies a value for logging, masking sensitive keys and token-shaped strings. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Error) {
    const includeStack = process.env.NODE_ENV !== 'production'
    return {
      name: value.name,
      message: redactString(value.message),
      ...(includeStack && value.stack ? { stack: redactString(value.stack) } : {}),
    }
  }
  if (typeof value !== 'object') return String(value)
  if (depth >= MAX_DEPTH) return '[Truncated]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, depth + 1, seen)
  }
  return out
}

const LEVEL_ORDER: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

function activeLevel(): LogLevel | 'silent' {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase()
  if (configured && configured in LEVEL_ORDER) return configured as LogLevel | 'silent'
  // Keep unit-test output readable; set LOG_LEVEL explicitly to see logs in tests.
  return process.env.NODE_ENV === 'test' || process.env.VITEST ? 'silent' : 'info'
}

export type LogSink = (level: LogLevel, line: string) => void

const defaultSink: LogSink = (level, line) => {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout
  stream.write(`${line}\n`)
}

export function createLogger(sink: LogSink = defaultSink, now: () => Date = () => new Date()) {
  function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return
    const context = getContext()
    const entry: Record<string, unknown> = {
      level,
      ts: now().toISOString(),
      msg: redactString(msg),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.traceId ? { traceId: context.traceId } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
      ...((redact(fields ?? {}) as Record<string, unknown>) ?? {}),
    }
    let line: string
    try {
      line = JSON.stringify(entry)
    } catch {
      line = JSON.stringify({ level, ts: entry.ts, msg: 'log entry could not be serialised' })
    }
    sink(level, line)
  }
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
  }
}

export const logger = createLogger()
