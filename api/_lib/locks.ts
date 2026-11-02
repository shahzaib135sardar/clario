import { randomUUID } from 'node:crypto'
import { getRedis } from './rateLimit'
import { logger } from './logger'

// Distributed lock on Redis (SET NX PX with an owner token). The TTL means a
// crashed holder can never block everyone forever (no deadlock), and the
// owner-checked release means a slow holder cannot free someone else's lock.

export interface LockStore {
  setIfAbsent(key: string, owner: string, ttlMs: number): Promise<boolean>
  getOwner(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

export function redisLockStore(): LockStore {
  const redis = getRedis()
  return {
    async setIfAbsent(key, owner, ttlMs) {
      return (await redis.set(key, owner, { nx: true, px: ttlMs })) === 'OK'
    },
    async getOwner(key) {
      return (await redis.get<string>(key)) ?? null
    },
    async delete(key) {
      await redis.del(key)
    },
  }
}

export type Lock = { key: string; owner: string }

export async function acquireLock(name: string, ttlMs: number, store: LockStore = redisLockStore()): Promise<Lock | null> {
  const key = `clario:lock:${name}`
  const owner = randomUUID()
  return (await store.setIfAbsent(key, owner, ttlMs)) ? { key, owner } : null
}

/** Releases only if we still own it (the lock may have expired and been taken by another instance). */
export async function releaseLock(lock: Lock, store: LockStore = redisLockStore()): Promise<boolean> {
  if ((await store.getOwner(lock.key)) !== lock.owner) return false
  await store.delete(lock.key)
  return true
}

export type WithLockOptions = { store?: LockStore; waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> }

/**
 * Runs `fn` while holding the lock. If it is busy, waits up to `waitMs` for it
 * to free up, then returns `{ acquired: false }` without running `fn`.
 * Redis errors fail open (runs `fn` unlocked): a lock is an optimisation here, not a guarantee.
 */
export async function withLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options: WithLockOptions = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let store: LockStore
  let lock: Lock | null = null
  try {
    store = options.store ?? redisLockStore()
    const deadline = Date.now() + (options.waitMs ?? 0)
    lock = await acquireLock(name, ttlMs, store)
    while (!lock && Date.now() < deadline) {
      await sleep(options.pollMs ?? 100)
      lock = await acquireLock(name, ttlMs, store)
    }
  } catch (error) {
    logger.warn('lock store unavailable, running without lock', { lock: name, reason: error instanceof Error ? error.message : 'unknown' })
    return { acquired: true, value: await fn() }
  }
  if (!lock) return { acquired: false }
  try {
    return { acquired: true, value: await fn() }
  } finally {
    await releaseLock(lock, store).catch(() => undefined)
  }
}

/**
 * Leader election for scheduled work: of all instances that try at the same
 * time, exactly one runs `fn`; the others skip it. (A lease, not a permanent leader.)
 */
export async function runAsLeader<T>(name: string, leaseMs: number, fn: () => Promise<T>, store?: LockStore): Promise<{ leader: boolean; value?: T }> {
  const result = await withLock(`leader:${name}`, leaseMs, fn, { store })
  return result.acquired ? { leader: true, value: result.value } : { leader: false }
}
