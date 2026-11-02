import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { brotliCompress, gzip } from 'node:zlib'
import { promisify } from 'node:util'

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.map'])
const NO_CACHE_FILES = new Set(['/index.html', '/sw.js', '/manifest.webmanifest', '/offline.html'])
const MIN_COMPRESS_BYTES = 1024

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Hashed build assets never change; the shell and service worker must always be revalidated. */
export function cacheControlFor(urlPath: string): string {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (urlPath === '/' || NO_CACHE_FILES.has(urlPath)) return 'no-cache'
  return 'public, max-age=86400'
}

/**
 * Maps a URL path to a file inside `root`, or null if it would escape it
 * (path traversal), contains odd characters, or points at a dotfile.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  if (decoded.split('/').some((segment) => segment.startsWith('.'))) return null

  const rootResolved = path.resolve(root)
  const resolved = path.resolve(rootResolved, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null
  return resolved
}

/** True for paths a single-page app should answer with index.html (no file extension). */
export function isSpaRoute(urlPath: string): boolean {
  const last = urlPath.split('/').filter(Boolean).pop() ?? ''
  return !last.includes('.')
}

export function chooseEncoding(acceptEncoding: string | string[] | undefined): 'br' | 'gzip' | null {
  const header = (Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding ?? '').toLowerCase()
  if (/\bbr\b/.test(header)) return 'br'
  if (/\bgzip\b/.test(header)) return 'gzip'
  return null
}

// Small bounded cache so each asset is compressed once, not per request.
const compressedCache = new Map<string, Buffer>()
const COMPRESSED_CACHE_MAX_ENTRIES = 64

async function compressed(file: string, mtimeMs: number, encoding: 'br' | 'gzip'): Promise<Buffer> {
  const key = `${file}:${mtimeMs}:${encoding}`
  const hit = compressedCache.get(key)
  if (hit) return hit
  const raw = await readFile(file)
  const out = encoding === 'br' ? await brotliAsync(raw) : await gzipAsync(raw)
  if (compressedCache.size >= COMPRESSED_CACHE_MAX_ENTRIES) {
    const oldest = compressedCache.keys().next().value
    if (oldest !== undefined) compressedCache.delete(oldest)
  }
  compressedCache.set(key, out)
  return out
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/** Serves one static request. Returns after the response has been written. */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    sendPlain(res, 405, 'Method not allowed')
    return
  }

  const requested = pathname === '/' ? '/index.html' : pathname
  let urlPath = requested
  let file = resolveStaticPath(root, requested)
  if (!file) {
    sendPlain(res, 404, 'Not found')
    return
  }

  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) info = null
  if (!info) {
    // Client-side routes (e.g. /settings/usage) all get the app shell.
    if (!isSpaRoute(requested)) {
      sendPlain(res, 404, 'Not found')
      return
    }
    urlPath = '/index.html'
    file = resolveStaticPath(root, urlPath)
    info = file ? await stat(file).catch(() => null) : null
    if (!file || !info || !info.isFile()) {
      sendPlain(res, 404, 'Not found')
      return
    }
  }

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  const headers: Record<string, string | number> = {
    'Content-Type': contentTypeFor(file),
    'Cache-Control': cacheControlFor(urlPath),
    ETag: etag,
    Vary: 'Accept-Encoding',
  }

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  const encoding = COMPRESSIBLE.has(path.extname(file).toLowerCase()) && info.size >= MIN_COMPRESS_BYTES
    ? chooseEncoding(req.headers['accept-encoding'])
    : null

  if (encoding) {
    const body = await compressed(file, info.mtimeMs, encoding)
    res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length })
    res.end(method === 'HEAD' ? undefined : body)
    return
  }

  res.writeHead(200, { ...headers, 'Content-Length': info.size })
  if (method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}
