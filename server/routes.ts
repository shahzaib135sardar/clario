import type { IncomingMessage, ServerResponse } from 'node:http'

// The route table for the self-host server. It mirrors the files under api/
// exactly (a test scans api/ and fails if the two ever differ). Each loader is
// a literal dynamic import so the bundler can include the handler while still
// loading it lazily, on first use.

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
type HandlerModule = { default: ApiHandler }

export type RouteDefinition = {
  /** Path pattern; `:name` matches exactly one segment, like `[name]` in api/. */
  pattern: string
  /** File under api/ this route serves, e.g. `documents/[id]/chat.ts`. */
  file: string
  load: () => Promise<HandlerModule>
}

export const ROUTES: readonly RouteDefinition[] = [
  { pattern: '/api/usage', file: 'usage.ts', load: () => import('../api/usage') },
  { pattern: '/api/documents', file: 'documents/index.ts', load: () => import('../api/documents/index') },
  { pattern: '/api/documents/:id', file: 'documents/[id]/index.ts', load: () => import('../api/documents/[id]/index') },
  { pattern: '/api/documents/:id/chart', file: 'documents/[id]/chart.ts', load: () => import('../api/documents/[id]/chart') },
  { pattern: '/api/documents/:id/chat', file: 'documents/[id]/chat.ts', load: () => import('../api/documents/[id]/chat') },
  { pattern: '/api/documents/:id/confirm', file: 'documents/[id]/confirm.ts', load: () => import('../api/documents/[id]/confirm') },
  { pattern: '/api/documents/:id/jobs', file: 'documents/[id]/jobs.ts', load: () => import('../api/documents/[id]/jobs') },
  { pattern: '/api/documents/:id/plan', file: 'documents/[id]/plan.ts', load: () => import('../api/documents/[id]/plan') },
  { pattern: '/api/documents/:id/pptx', file: 'documents/[id]/pptx.ts', load: () => import('../api/documents/[id]/pptx') },
  {
    pattern: '/api/documents/:id/resume-analysis',
    file: 'documents/[id]/resume-analysis.ts',
    load: () => import('../api/documents/[id]/resume-analysis'),
  },
  { pattern: '/api/documents/:id/summary', file: 'documents/[id]/summary.ts', load: () => import('../api/documents/[id]/summary') },
  { pattern: '/api/internal/:task', file: 'internal/[task].ts', load: () => import('../api/internal/[task]') },
]

export type RouteMatch = { route: RouteDefinition; params: Record<string, string> }

/**
 * `/api/v1/...` is the versioned alias of `/api/...` (vercel.json has the same
 * rewrite). Returns the canonical path, or null when the path is not under /api.
 */
export function normalizeApiPath(pathname: string): string | null {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (trimmed === '/api/v1' || trimmed.startsWith('/api/v1/')) return `/api${trimmed.slice('/api/v1'.length)}`
  if (trimmed === '/api' || trimmed.startsWith('/api/')) return trimmed
  return null
}

/** Pure lookup: the handler file and `:param` values for an API path, or null. */
export function matchRoute(pathname: string, routes: readonly RouteDefinition[] = ROUTES): RouteMatch | null {
  const canonical = normalizeApiPath(pathname)
  if (!canonical) return null
  const segments = canonical.split('/').filter(Boolean)

  for (const route of routes) {
    const pattern = route.pattern.split('/').filter(Boolean)
    if (pattern.length !== segments.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let index = 0; index < pattern.length; index += 1) {
      const want = pattern[index]
      const got = segments[index]
      if (want.startsWith(':')) {
        if (!got) {
          matched = false
          break
        }
        params[want.slice(1)] = got
      } else if (want !== got) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return null
}

/** The pattern a file under api/ is expected to be served at (`[id]` becomes `:id`). */
export function expectedPatternForFile(file: string): string {
  const withoutExt = file.replace(/\.ts$/, '').replace(/(^|\/)index$/, '')
  const parts = withoutExt.split('/').filter(Boolean).map((part) => part.replace(/^\[(.+)\]$/, ':$1'))
  return `/api${parts.length ? `/${parts.join('/')}` : ''}`
}
