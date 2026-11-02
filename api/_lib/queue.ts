import { randomUUID } from 'node:crypto'
import { getRedis } from './rateLimit'
import { backoffDelay } from './resilience'

// A small reliable job queue on Redis lists with retries and a dead-letter
// queue (DLQ). Jobs that keep failing are parked in the DLQ instead of being
// retried forever or silently lost, so a person can inspect and requeue them.
//   pending list -> reserve() moves a job to "processing" -> ack() removes it,
//   fail() requeues it after exponential backoff, or moves it to the DLQ after maxAttempts.

export type QueueJob<T = unknown> = {
  id: string
  payload: T
  attempts: number
  /** Epoch ms before which the job should not be processed again. */
  notBefore: number
  lastError?: string
}

export interface QueueStore {
  push(list: string, value: string): Promise<void>
  /** Atomically move the oldest item from `from` to `to` (LMOVE). */
  move(from: string, to: string): Promise<string | null>
  remove(list: string, value: string): Promise<void>
  range(list: string, limit: number): Promise<string[]>
  length(list: string): Promise<number>
}

export function redisQueueStore(): QueueStore {
  const redis = getRedis()
  return {
    async push(list, value) {
      await redis.rpush(list, value)
    },
    async move(from, to) {
      return (await redis.lmove<string>(from, to, 'left', 'right')) ?? null
    },
    async remove(list, value) {
      await redis.lrem(list, 1, value)
    },
    async range(list, limit) {
      return (await redis.lrange<string>(list, 0, limit - 1)).map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    },
    async length(list) {
      return redis.llen(list)
    },
  }
}

export type QueueOptions = {
  name: string
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  store?: QueueStore
  now?: () => number
  random?: () => number
}

export function createQueue<T = unknown>(options: QueueOptions) {
  const { name, maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 60_000 } = options
  const store = options.store ?? redisQueueStore()
  const now = options.now ?? Date.now
  const keys = { pending: `clario:queue:${name}:pending`, processing: `clario:queue:${name}:processing`, dead: `clario:queue:${name}:dead` }

  return {
    keys,
    async enqueue(payload: T): Promise<QueueJob<T>> {
      const job: QueueJob<T> = { id: randomUUID(), payload, attempts: 0, notBefore: 0 }
      await store.push(keys.pending, JSON.stringify(job))
      return job
    },
    /** Next job that is due, or null. Jobs not yet due are put back at the end of the line. */
    async reserve(): Promise<{ job: QueueJob<T>; raw: string } | null> {
      const size = await store.length(keys.pending)
      for (let i = 0; i < size; i += 1) {
        const raw = await store.move(keys.pending, keys.processing)
        if (raw === null) return null
        const job = JSON.parse(raw) as QueueJob<T>
        if (job.notBefore <= now()) return { job, raw }
        await store.remove(keys.processing, raw)
        await store.push(keys.pending, raw)
      }
      return null
    },
    async ack(reserved: { raw: string }): Promise<void> {
      await store.remove(keys.processing, reserved.raw)
    },
    /** Records a failure: retry with exponential backoff, or dead-letter once attempts run out. */
    async fail(reserved: { job: QueueJob<T>; raw: string }, error: unknown): Promise<'retry' | 'dead'> {
      await store.remove(keys.processing, reserved.raw)
      const attempts = reserved.job.attempts + 1
      const lastError = error instanceof Error ? error.message.slice(0, 300) : 'unknown error'
      if (attempts >= maxAttempts) {
        await store.push(keys.dead, JSON.stringify({ ...reserved.job, attempts, lastError }))
        return 'dead'
      }
      const delay = backoffDelay(attempts, baseDelayMs, maxDelayMs, 2, options.random)
      await store.push(keys.pending, JSON.stringify({ ...reserved.job, attempts, lastError, notBefore: now() + delay }))
      return 'retry'
    },
    async listDead(limit = 50): Promise<QueueJob<T>[]> {
      return (await store.range(keys.dead, limit)).map((raw) => JSON.parse(raw) as QueueJob<T>)
    },
    /** Moves every dead job back to pending with a fresh attempt count. Returns how many. */
    async requeueDead(): Promise<number> {
      let moved = 0
      for (let raw = await store.move(keys.dead, keys.processing); raw !== null; raw = await store.move(keys.dead, keys.processing)) {
        const job = JSON.parse(raw) as QueueJob<T>
        await store.remove(keys.processing, raw)
        await store.push(keys.pending, JSON.stringify({ ...job, attempts: 0, notBefore: 0 }))
        moved += 1
      }
      return moved
    },
    async stats() {
      const [pending, processing, dead] = await Promise.all([store.length(keys.pending), store.length(keys.processing), store.length(keys.dead)])
      return { pending, processing, dead }
    },
  }
}
