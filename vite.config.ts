import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // These libraries are only imported on demand (upload and chart screens).
  // Without this, the dev server discovers them mid-session, re-bundles, and
  // the already-open page keeps a stale module URL, which shows up as
  // "Failed to fetch dynamically imported module". Pre-bundling at startup
  // avoids that. It has no effect on production builds.
  optimizeDeps: {
    include: ['pdfjs-dist', 'mammoth', 'recharts'],
  },
})
