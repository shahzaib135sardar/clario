// Process-local metrics: counters and latency histograms, exposed in the
// Prometheus text format. On a long-lived server (Docker/Kubernetes) these are
// accurate per instance and Prometheus aggregates them. On serverless each
// warm instance only knows about itself, so treat the numbers there as a
// sample, not a total. Label values are bounded (route templates, never raw
// ids) so memory cannot grow without limit.

export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000, 25000] as const

const MAX_SERIES_PER_METRIC = 200
const OVERFLOW_LABEL = '__other__'

type Labels = Record<string, string>

type Histogram = { counts: number[]; sum: number; count: number }

const counters = new Map<string, Map<string, { labels: Labels; value: number }>>()
const histograms = new Map<string, Map<string, { labels: Labels; data: Histogram }>>()
const startedAt = Date.now()

function cleanLabelValue(value: string): string {
  return String(value).replace(/[^\w:./-]/g, '_').slice(0, 80)
}

function normalizeLabels(labels: Labels): Labels {
  const out: Labels = {}
  for (const key of Object.keys(labels).sort()) out[key] = cleanLabelValue(labels[key])
  return out
}

function seriesKey(labels: Labels): string {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(',')
}

function boundedSeries<T>(store: Map<string, T>, key: string, labels: Labels): { key: string; labels: Labels } {
  if (store.has(key) || store.size < MAX_SERIES_PER_METRIC) return { key, labels }
  const overflow: Labels = {}
  for (const name of Object.keys(labels)) overflow[name] = OVERFLOW_LABEL
  return { key: seriesKey(overflow), labels: overflow }
}

export function incCounter(name: string, labels: Labels = {}, by = 1): void {
  let series = counters.get(name)
  if (!series) counters.set(name, (series = new Map()))
  const normalized = normalizeLabels(labels)
  const { key, labels: finalLabels } = boundedSeries(series, seriesKey(normalized), normalized)
  const existing = series.get(key)
  if (existing) existing.value += by
  else series.set(key, { labels: finalLabels, value: by })
}

export function getCounter(name: string, labels: Labels = {}): number {
  return counters.get(name)?.get(seriesKey(normalizeLabels(labels)))?.value ?? 0
}

export function observeHistogram(name: string, value: number, labels: Labels = {}): void {
  let series = histograms.get(name)
  if (!series) histograms.set(name, (series = new Map()))
  const normalized = normalizeLabels(labels)
  const { key, labels: finalLabels } = boundedSeries(series, seriesKey(normalized), normalized)
  let entry = series.get(key)
  if (!entry) {
    entry = { labels: finalLabels, data: { counts: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0 } }
    series.set(key, entry)
  }
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => value <= bound)
  entry.data.counts[index === -1 ? LATENCY_BUCKETS_MS.length : index] += 1
  entry.data.sum += value
  entry.data.count += 1
}

/**
 * Estimates a quantile (0–1) from bucket counts using linear interpolation
 * inside the bucket — the same approach as Prometheus' histogram_quantile.
 * `counts` has one entry per bound plus a final overflow bucket.
 */
export function percentileFromBuckets(counts: readonly number[], bounds: readonly number[], quantile: number): number {
  const total = counts.reduce((sum, value) => sum + value, 0)
  if (total === 0) return 0
  const rank = Math.min(Math.max(quantile, 0), 1) * total
  let cumulative = 0
  for (let index = 0; index < counts.length; index += 1) {
    const previous = cumulative
    cumulative += counts[index]
    if (cumulative >= rank && counts[index] > 0) {
      if (index >= bounds.length) return bounds[bounds.length - 1] // overflow bucket: report the top bound
      const lower = index === 0 ? 0 : bounds[index - 1]
      const upper = bounds[index]
      return lower + ((rank - previous) / counts[index]) * (upper - lower)
    }
  }
  return bounds[bounds.length - 1]
}

function mergedBuckets(name: string): { counts: number[]; sum: number; count: number } {
  const merged = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) as number[]
  let sum = 0
  let count = 0
  for (const { data } of histograms.get(name)?.values() ?? []) {
    data.counts.forEach((value, index) => (merged[index] += value))
    sum += data.sum
    count += data.count
  }
  return { counts: merged, sum, count }
}

// --- HTTP request metrics -----------------------------------------------------------

export const REQUEST_COUNTER = 'http_requests_total'
export const REQUEST_LATENCY = 'http_request_duration_ms'

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Collapses ids so one route is one label: /api/documents/<uuid>/chat -> /api/documents/:id/chat */
export function routeTemplate(urlOrPath: string | undefined): string {
  let pathname = '/'
  try {
    pathname = new URL(urlOrPath ?? '/', 'http://internal').pathname
  } catch {
    return '/invalid'
  }
  const segments = pathname.split('/').filter(Boolean).slice(0, 6)
  if (segments[0] !== 'api') return '/other'
  return `/${segments.map((segment) => (UUID_SEGMENT.test(segment) || /^\d+$/.test(segment) ? ':id' : segment.slice(0, 40))).join('/')}`
}

export function recordRequest(input: { method: string; route: string; status: number; durationMs: number }): void {
  incCounter(REQUEST_COUNTER, { method: input.method, route: input.route, status: String(input.status) })
  observeHistogram(REQUEST_LATENCY, input.durationMs, { route: input.route })
}

// --- SLIs, SLOs and error budgets -----------------------------------------------------

export type SliSnapshot = {
  total: number
  failed: number
  availability: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  /** Share of requests that finished within `latencyThresholdMs`. */
  fastFraction: number
  latencyThresholdMs: number
}

export function sumRequests(): { total: number; failed: number } {
  let total = 0
  let failed = 0
  for (const { labels, value } of counters.get(REQUEST_COUNTER)?.values() ?? []) {
    total += value
    if (Number(labels.status) >= 500) failed += value
  }
  return { total, failed }
}

/** Fraction of requests that finished within the largest bucket bound that is <= `thresholdMs`. */
export function fractionUnder(thresholdMs: number): number {
  const { counts } = mergedBuckets(REQUEST_LATENCY)
  const total = counts.reduce((sum, value) => sum + value, 0)
  if (total === 0) return 1
  let within = 0
  LATENCY_BUCKETS_MS.forEach((bound, index) => {
    if (bound <= thresholdMs) within += counts[index]
  })
  return within / total
}

export function sliSnapshot(latencyThresholdMs = 1500): SliSnapshot {
  const { total, failed } = sumRequests()
  const { counts } = mergedBuckets(REQUEST_LATENCY)
  return {
    total,
    failed,
    availability: total === 0 ? 1 : (total - failed) / total,
    p50Ms: percentileFromBuckets(counts, LATENCY_BUCKETS_MS, 0.5),
    p95Ms: percentileFromBuckets(counts, LATENCY_BUCKETS_MS, 0.95),
    p99Ms: percentileFromBuckets(counts, LATENCY_BUCKETS_MS, 0.99),
    fastFraction: fractionUnder(latencyThresholdMs),
    latencyThresholdMs,
  }
}

export type ErrorBudget = {
  target: number
  allowedBadEvents: number
  badEvents: number
  /** 1 = untouched, 0 = fully spent, negative = overspent. */
  remainingFraction: number
  /** 1 = burning exactly at the rate the SLO allows; above 1 the budget runs out early. */
  burnRate: number
}

/**
 * Error budget for an SLO such as 99.5% availability. With `good`/`total`
 * events in the window, the budget is the (1 - target) share of events that
 * may be bad.
 */
export function errorBudget(target: number, good: number, total: number): ErrorBudget {
  if (!(target > 0 && target < 1)) throw new RangeError('SLO target must be between 0 and 1 (exclusive).')
  const allowedBadEvents = (1 - target) * total
  const badEvents = total - good
  const badFraction = total === 0 ? 0 : badEvents / total
  return {
    target,
    allowedBadEvents,
    badEvents,
    remainingFraction: allowedBadEvents === 0 ? (badEvents === 0 ? 1 : 0) : 1 - badEvents / allowedBadEvents,
    burnRate: badFraction / (1 - target),
  }
}

export const DEFAULT_SLOS = { availabilityTarget: 0.995, latencyTarget: 0.95, latencyThresholdMs: 1500 } as const

export function sloReport(slos = DEFAULT_SLOS) {
  const sli = sliSnapshot(slos.latencyThresholdMs)
  const availabilityBudget = errorBudget(slos.availabilityTarget, sli.total - sli.failed, sli.total)
  const latencyBudget = errorBudget(slos.latencyTarget, Math.round(sli.fastFraction * sli.total), sli.total)
  return { sli, slos, availabilityBudget, latencyBudget }
}

// --- Prometheus exposition -----------------------------------------------------------

function formatLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return parts.length === 0 ? '' : `{${parts.join(',')}}`
}

export function renderPrometheus(): string {
  const lines: string[] = []

  for (const [name, series] of counters) {
    lines.push(`# TYPE ${name} counter`)
    for (const { labels, value } of series.values()) lines.push(`${name}${formatLabels(labels)} ${value}`)
  }

  for (const [name, series] of histograms) {
    lines.push(`# TYPE ${name} histogram`)
    for (const { labels, data } of series.values()) {
      let cumulative = 0
      LATENCY_BUCKETS_MS.forEach((bound, index) => {
        cumulative += data.counts[index]
        lines.push(`${name}_bucket${formatLabels({ ...labels, le: String(bound) })} ${cumulative}`)
      })
      lines.push(`${name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${data.count}`)
      lines.push(`${name}_sum${formatLabels(labels)} ${Math.round(data.sum * 1000) / 1000}`)
      lines.push(`${name}_count${formatLabels(labels)} ${data.count}`)
    }
  }

  const memory = process.memoryUsage()
  lines.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${memory.rss}`)
  lines.push('# TYPE process_heap_used_bytes gauge', `process_heap_used_bytes ${memory.heapUsed}`)
  lines.push('# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`)
  return `${lines.join('\n')}\n`
}

/** Test hook. */
export function resetMetrics(): void {
  counters.clear()
  histograms.clear()
}
