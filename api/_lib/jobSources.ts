import { getRedis } from './rateLimit'
import { resilientFetch } from './resilience'
import { withLock } from './locks'

// Free, keyless public job boards. LinkedIn and Google Jobs have no free
// official API (and scraping them breaks their terms), so they are not used.
//
// Each board publishes one public feed. We download the whole feed at most
// every few hours and cache it, then match locally — so nothing from a
// resume is ever sent to a job board, and Remotive's "a few requests a day"
// guidance is respected no matter how many people use the app.
//
// Every listing keeps the URL of its page on the board that published it;
// that page is what the user is sent to, and it is the attribution these
// boards require.

export type JobSourceId = 'remotive' | 'arbeitnow' | 'remoteok'

export type JobSourceInfo = { label: string; homepage: string; hosts: string[] }

export const JOB_SOURCES: Record<JobSourceId, JobSourceInfo> = {
  remotive: { label: 'Remotive', homepage: 'https://remotive.com', hosts: ['remotive.com'] },
  arbeitnow: { label: 'Arbeitnow', homepage: 'https://www.arbeitnow.com', hosts: ['arbeitnow.com', 'arbeitnow.co.uk'] },
  remoteok: { label: 'Remote OK', homepage: 'https://remoteok.com', hosts: ['remoteok.com'] },
}

export const JOB_SOURCE_IDS = Object.keys(JOB_SOURCES) as JobSourceId[]

/** A listing as cached. `text` is a short plain-text excerpt used for matching only. */
export type FeedJob = {
  id: string
  source: JobSourceId
  title: string
  company: string
  location: string
  remote: boolean
  url: string
  tags: string[]
  postedAt: string | null
  salary: string | null
  text: string
}

export class JobSourceError extends Error {}

const MAX_JOBS_PER_SOURCE = 400
const TEXT_CHARS = 500
const FETCH_TIMEOUT_MS = 7000
const FRESH_MS = 8 * 60 * 60 * 1000 // 3 downloads per board per day, well inside Remotive's limit
const KEEP_SECONDS = 3 * 24 * 60 * 60 // keep an old copy to fall back on if a board is down
const ARBEITNOW_PAGES = 3
const USER_AGENT = 'Clario/1.0 (job suggestions; links back to the original listing)'

// --- Pure helpers (exported for tests) ---------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Job descriptions arrive as HTML from third parties. Reduce them to plain text. */
export function htmlToText(html: unknown): string {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === '#') {
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
      }
      return ENTITIES[entity.toLowerCase()] ?? match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Only https links that really belong to the board that supplied them are kept. */
export function safeJobUrl(raw: unknown, hosts: string[]): string | null {
  if (typeof raw !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  if (!hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null
  return parsed.toString()
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function cleanTags(...lists: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const tag = clean(entry, 40)
      const key = tag.toLowerCase()
      if (!tag || seen.has(key)) continue
      seen.add(key)
      out.push(tag)
      if (out.length >= 12) return out
    }
  }
  return out
}

function toIso(value: unknown): string | null {
  let ms = NaN
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value < 1e12 ? value * 1000 : value // unix seconds or milliseconds
  } else if (typeof value === 'string' && value.trim()) {
    const text = value.trim()
    // Remotive sends timestamps without a zone; they are UTC.
    ms = Date.parse(/T\d\d:\d\d(:\d\d)?$/.test(text) ? `${text}Z` : text)
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function newestFirst(jobs: FeedJob[]): FeedJob[] {
  const seen = new Set<string>()
  return jobs
    .filter((job) => (seen.has(job.id) ? false : (seen.add(job.id), true)))
    .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''))
    .slice(0, MAX_JOBS_PER_SOURCE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// --- Per-board parsers ---------------------------------------------------------

/** https://remotive.com/api/remote-jobs */
export function parseRemotive(payload: unknown): FeedJob[] {
  const list = isRecord(payload) ? payload.jobs : undefined
  if (!Array.isArray(list)) throw new JobSourceError('Remotive returned an unexpected response.')
  const jobs: FeedJob[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const url = safeJobUrl(item.url, JOB_SOURCES.remotive.hosts)
    const title = clean(item.title, 140)
    if (!url || !title || item.id === undefined) continue
    jobs.push({
      id: `remotive:${String(item.id)}`,
      source: 'remotive',
      title,
      company: clean(item.company_name, 100),
      location: clean(item.candidate_required_location, 100) || 'Worldwide',
      remote: true,
      url,
      tags: cleanTags(item.tags, [item.category], [String(item.job_type ?? '').replace(/_/g, ' ')]),
      postedAt: toIso(item.publication_date),
      salary: clean(item.salary, 60) || null,
      text: htmlToText(item.description).slice(0, TEXT_CHARS),
    })
  }
  return newestFirst(jobs)
}

/** https://www.arbeitnow.com/api/job-board-api */
export function parseArbeitnow(payload: unknown): FeedJob[] {
  const list = isRecord(payload) ? payload.data : undefined
  if (!Array.isArray(list)) throw new JobSourceError('Arbeitnow returned an unexpected response.')
  const jobs: FeedJob[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const url = safeJobUrl(item.url, JOB_SOURCES.arbeitnow.hosts)
    const title = clean(item.title, 140)
    const slug = clean(item.slug, 200)
    if (!url || !title || !slug) continue
    jobs.push({
      id: `arbeitnow:${slug}`,
      source: 'arbeitnow',
      title,
      company: clean(item.company_name, 100),
      location: clean(item.location, 100) || (item.remote === true ? 'Remote' : ''),
      remote: item.remote === true,
      url,
      tags: cleanTags(item.tags, item.job_types),
      postedAt: toIso(item.created_at),
      salary: null,
      text: htmlToText(item.description).slice(0, TEXT_CHARS),
    })
  }
  return newestFirst(jobs)
}

/** https://remoteok.com/api — the first array element is a legal notice, not a job. */
export function parseRemoteOk(payload: unknown): FeedJob[] {
  if (!Array.isArray(payload)) throw new JobSourceError('Remote OK returned an unexpected response.')
  const jobs: FeedJob[] = []
  for (const item of payload) {
    if (!isRecord(item)) continue
    const title = clean(item.position, 140)
    const url = safeJobUrl(item.url, JOB_SOURCES.remoteok.hosts)
    if (!title || !url || item.id === undefined) continue
    const min = typeof item.salary_min === 'number' ? item.salary_min : 0
    const max = typeof item.salary_max === 'number' ? item.salary_max : 0
    const salary = min > 0 && max >= min ? `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')}` : null
    jobs.push({
      id: `remoteok:${String(item.id)}`,
      source: 'remoteok',
      title,
      company: clean(item.company, 100),
      location: clean(item.location, 100) || 'Remote',
      remote: true,
      url,
      tags: cleanTags(item.tags),
      postedAt: toIso(item.epoch) ?? toIso(item.date),
      salary,
      text: htmlToText(item.description).slice(0, TEXT_CHARS),
    })
  }
  return newestFirst(jobs)
}

// --- Network ---------------------------------------------------------------------

async function fetchJson(url: string, label: string): Promise<unknown> {
  let response: Response
  try {
    response = await resilientFetch(
      `jobs-${label.toLowerCase().replace(/\s+/g, '-')}`,
      url,
      { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } },
      { timeoutMs: FETCH_TIMEOUT_MS, retries: 1, baseDelayMs: 400 },
    )
  } catch {
    throw new JobSourceError(`${label} could not be reached.`)
  }
  if (!response.ok) throw new JobSourceError(`${label} returned an error (${response.status}).`)
  try {
    return await response.json()
  } catch {
    throw new JobSourceError(`${label} returned an unreadable response.`)
  }
}

const FETCHERS: Record<JobSourceId, () => Promise<FeedJob[]>> = {
  remotive: async () => parseRemotive(await fetchJson('https://remotive.com/api/remote-jobs', 'Remotive')),
  remoteok: async () => parseRemoteOk(await fetchJson('https://remoteok.com/api', 'Remote OK')),
  arbeitnow: async () => {
    const pages = await Promise.allSettled(
      Array.from({ length: ARBEITNOW_PAGES }, (_, index) =>
        fetchJson(`https://www.arbeitnow.com/api/job-board-api?page=${index + 1}`, 'Arbeitnow').then(parseArbeitnow),
      ),
    )
    const first = pages[0]
    if (first.status === 'rejected') throw first.reason
    return newestFirst(pages.flatMap((page) => (page.status === 'fulfilled' ? page.value : [])))
  },
}

// --- Cache -------------------------------------------------------------------------

type CachedFeed = { fetchedAt: number; jobs: FeedJob[] }

const memoryCache = new Map<JobSourceId, CachedFeed>()
const cacheKey = (source: JobSourceId) => `clario:jobs:feed:${source}`

function isCachedFeed(value: unknown): value is CachedFeed {
  return isRecord(value) && typeof value.fetchedAt === 'number' && Array.isArray(value.jobs)
}

async function readCache(source: JobSourceId): Promise<CachedFeed | null> {
  try {
    const stored = await getRedis().get<unknown>(cacheKey(source))
    if (isCachedFeed(stored)) return stored
  } catch (error) {
    console.error('jobs:cache-read', source, error instanceof Error ? error.message : error)
  }
  return memoryCache.get(source) ?? null
}

async function writeCache(source: JobSourceId, feed: CachedFeed): Promise<void> {
  memoryCache.set(source, feed)
  try {
    await getRedis().set(cacheKey(source), feed, { ex: KEEP_SECONDS })
  } catch (error) {
    console.error('jobs:cache-write', source, error instanceof Error ? error.message : error)
  }
}

export type FeedStatus = 'fresh' | 'cached' | 'stale' | 'unavailable'
export type FeedResult = { source: JobSourceId; status: FeedStatus; jobs: FeedJob[] }

/**
 * Returns a board's listings: the cached copy while it is fresh, otherwise a
 * new download — falling back to the last good copy if the board is down.
 */
export async function loadFeed(
  source: JobSourceId,
  options: { now?: number; fetcher?: () => Promise<FeedJob[]>; force?: boolean } = {},
): Promise<FeedResult> {
  const now = options.now ?? Date.now()
  const isFresh = (feed: CachedFeed | null): feed is CachedFeed => feed !== null && now - feed.fetchedAt < FRESH_MS
  const cached = await readCache(source)
  if (!options.force && isFresh(cached)) return { source, status: 'cached', jobs: cached.jobs }

  // Only one instance downloads at a time (a cold or expired cache would otherwise send a
  // burst of identical requests to the board). Callers that lose the race wait briefly,
  // then use whatever the winner cached.
  const locked = await withLock(
    `feed:${source}`,
    30_000,
    async (): Promise<FeedResult> => {
      if (!options.force) {
        const latest = await readCache(source)
        if (isFresh(latest)) return { source, status: 'cached', jobs: latest.jobs }
      }
      try {
        const jobs = await (options.fetcher ?? FETCHERS[source])()
        await writeCache(source, { fetchedAt: now, jobs })
        return { source, status: 'fresh', jobs }
      } catch (error) {
        console.error('jobs:fetch', source, error instanceof Error ? error.message : error)
        if (cached) return { source, status: 'stale', jobs: cached.jobs }
        return { source, status: 'unavailable', jobs: [] }
      }
    },
    { waitMs: 8_000, pollMs: 250 },
  )
  if (locked.acquired) return locked.value
  const latest = await readCache(source)
  return latest ? { source, status: isFresh(latest) ? 'cached' : 'stale', jobs: latest.jobs } : { source, status: 'unavailable', jobs: [] }
}

export async function loadAllFeeds(options: { force?: boolean } = {}): Promise<FeedResult[]> {
  return Promise.all(JOB_SOURCE_IDS.map((source) => loadFeed(source, { force: options.force })))
}

/** Test hook: forget the in-process copy. */
export function clearJobMemoryCache(): void {
  memoryCache.clear()
}
