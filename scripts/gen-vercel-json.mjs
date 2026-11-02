// Regenerates vercel.json from the single CSP definition in server/security.ts,
// so the Vercel deployment and the self-host server can never send different policies.
// Usage: npx esbuild server/security.ts --bundle --platform=node --format=esm --outfile=/tmp/sec.mjs && node scripts/gen-vercel-json.mjs /tmp/sec.mjs
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, HSTS_VALUE } = await import(pathToFileURL(path.resolve(process.argv[2])).href)
const header = (key, value) => ({ key, value })
const config = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  headers: [
    {
      source: '/(.*)',
      // Not on localhost: the Vite dev server injects an inline script (React refresh) that this CSP would block.
      has: [{ type: 'host', value: '^(?!localhost|127\\.0\\.0\\.1).*$' }],
      headers: [
        header('Content-Security-Policy', CONTENT_SECURITY_POLICY),
        header('Strict-Transport-Security', HSTS_VALUE),
        ...Object.entries(SECURITY_HEADERS).map(([key, value]) => header(key, value)),
      ],
    },
    { source: '/assets/(.*)', headers: [header('Cache-Control', 'public, max-age=31536000, immutable')] },
    { source: '/icons/(.*)', headers: [header('Cache-Control', 'public, max-age=86400')] },
    { source: '/(sw.js|manifest.webmanifest|offline.html)', headers: [header('Cache-Control', 'no-cache')] },
    { source: '/api/(.*)', headers: [header('Cache-Control', 'no-store')] },
  ],
  rewrites: [
    { source: '/api/v1/:path*', destination: '/api/:path*' },
    // Page routes only. Anything with a file extension (scripts, styles, icons) and the Vite dev server's
    // internal paths (/src, /@vite, /node_modules) must NOT be rewritten to index.html, or `vercel dev` breaks.
    { source: '/((?!api/|assets/|icons/|src/|@|node_modules/|.*\\..*).*)', destination: '/index.html' },
  ],
  // Keeps the shared job-feed cache warm so a user's first request is not the one that pays for the downloads.
  // Vercel sends "Authorization: Bearer $CRON_SECRET" automatically when CRON_SECRET is set.
  crons: [{ path: '/api/internal/warm-feeds', schedule: '0 */8 * * *' }],
}
writeFileSync('vercel.json', `${JSON.stringify(config, null, 2)}\n`)
