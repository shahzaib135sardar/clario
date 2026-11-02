import { eventBus, type EventEnvelope, type EventName } from './events'
import { logger } from './logger'
import { incCounter } from './metrics'

// Writes one structured audit line for every sensitive action: who, what,
// which resource, from where, under which request id. Appears in the platform
// logs (Vercel / container stdout) as JSON with `audit: true`.

const AUDITED: readonly EventName[] = ['document.created', 'document.deleted', 'artifact.generated', 'resume.analyzed', 'jobs.refreshed']
let registered = false

export function auditEntry(event: EventEnvelope): Record<string, unknown> {
  return { audit: true, action: event.name, actor: event.meta.userId ?? 'unknown', ip: event.meta.ip, requestId: event.meta.requestId, at: event.at, ...event.payload }
}

export function registerAuditSubscribers(): void {
  if (registered) return
  registered = true
  for (const name of AUDITED) {
    eventBus.subscribe(name, (event) => {
      logger.info('audit', auditEntry(event))
      incCounter('audit_events_total', { action: event.name })
    })
  }
}

/** Test hook. */
export function resetAuditRegistration(): void {
  registered = false
}
