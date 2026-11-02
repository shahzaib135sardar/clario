import { randomBytes } from 'node:crypto'
import { getContext, type LogContext } from './logger'

// W3C Trace Context (https://www.w3.org/TR/trace-context/): a `traceparent`
// header of the form `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`.
// The trace id ties one user action together across this app's logs and any
// downstream service that also understands the header.

export type TraceParent = { version: string; traceId: string; spanId: string; flags: string }

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const ZERO_TRACE = '0'.repeat(32)
const ZERO_SPAN = '0'.repeat(16)

export function parseTraceparent(header: string | undefined | null): TraceParent | null {
  if (!header) return null
  const match = TRACEPARENT.exec(header.trim().toLowerCase())
  if (!match) return null
  const [, version, traceId, spanId, flags] = match
  if (version === 'ff' || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null
  return { version, traceId, spanId, flags }
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex')
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`
}

/** Continues an inbound trace if there is one, otherwise starts a new one. Always makes a fresh span. */
export function resolveTrace(inboundHeader: string | undefined | null): { traceId: string; spanId: string; parentSpanId?: string } {
  const parent = parseTraceparent(inboundHeader)
  if (parent) return { traceId: parent.traceId, spanId: newSpanId(), parentSpanId: parent.spanId }
  return { traceId: newTraceId(), spanId: newSpanId() }
}

/** Headers to attach to an outbound call so the downstream service joins this trace. */
export function outboundTraceHeaders(context: LogContext = getContext()): Record<string, string> {
  if (!context.traceId) return {}
  return { traceparent: formatTraceparent(context.traceId, newSpanId()) }
}
