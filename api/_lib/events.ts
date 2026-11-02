import { getContext, logger } from './logger'

// A tiny typed publish/subscribe bus. Handlers can't break each other or the
// request: every handler runs isolated, failures are logged and swallowed.
// It is in-process by design (serverless instances don't share memory); for
// cross-instance work use queue.ts.

export type DomainEvents = {
  'document.created': { documentId: string; fileType?: string }
  'document.deleted': { documentId: string }
  'artifact.generated': { documentId: string; kind: string }
  'resume.analyzed': { documentId: string }
  'jobs.refreshed': { documentId: string; matches: number }
}

export type EventName = keyof DomainEvents
export type EventMeta = { userId?: string; ip?: string; requestId?: string }
export type EventEnvelope<K extends EventName = EventName> = { name: K; payload: DomainEvents[K]; meta: EventMeta; at: string }
export type Handler<K extends EventName> = (event: EventEnvelope<K>) => void | Promise<void>

export function createEventBus() {
  const handlers = new Map<EventName, Set<Handler<EventName>>>()
  return {
    subscribe<K extends EventName>(name: K, handler: Handler<K>): () => void {
      const set = handlers.get(name) ?? new Set()
      set.add(handler as Handler<EventName>)
      handlers.set(name, set)
      return () => set.delete(handler as Handler<EventName>)
    },
    async publish<K extends EventName>(name: K, payload: DomainEvents[K], meta: EventMeta = {}): Promise<void> {
      const set = handlers.get(name)
      if (!set || set.size === 0) return
      const envelope: EventEnvelope<K> = { name, payload, meta, at: new Date().toISOString() }
      const results = await Promise.allSettled([...set].map(async (handler) => handler(envelope as EventEnvelope)))
      for (const result of results) {
        if (result.status === 'rejected') logger.error('event handler failed', { event: name, reason: result.reason instanceof Error ? result.reason.message : 'unknown' })
      }
    },
    listenerCount: (name: EventName) => handlers.get(name)?.size ?? 0,
    clear: () => handlers.clear(),
  }
}

export const eventBus = createEventBus()

/** Publishes an event stamped with who/where/which request, taken from the active request context. */
export function emitEvent<K extends EventName>(name: K, payload: DomainEvents[K]): Promise<void> {
  const { userId, ip, requestId } = getContext()
  return eventBus.publish(name, payload, { userId, ip, requestId })
}
