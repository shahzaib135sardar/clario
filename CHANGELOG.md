# Changelog
Format: [Keep a Changelog](https://keepachangelog.com), versions follow [Semantic Versioning](https://semver.org)
(`MAJOR` breaking API change, `MINOR` backwards-compatible feature, `PATCH` fix). The HTTP API is also reachable as
`/api/v1/...`; a breaking change would ship as `/api/v2/...` while v1 keeps working.

## 0.2.1
### Fixed
- `vercel dev` no longer rewrites Vite dev-server and file paths to index.html, and the CSP is not sent on localhost (it blocked the dev server).
### Changed
- Typography: Instrument Sans for UI, Newsreader for headings; smallest UI text raised from 8px to 11px; spacing, button, input and card polish.

## 0.2.0
### Added
- Job suggestions from a resume (Remotive, Arbeitnow, Remote OK) with links to the original postings.
- Separate sidebar sections: Resume analyzer, Jobs, AI chat (locked behind `VITE_FEATURE_AI_CHAT`), Settings.
- Settings split into Profile, Workspace, Usage and Security pages.
- Installable PWA, mobile bottom tab bar, offline page.
- Reliability: timeouts, retries with backoff, circuit breaker, bulkhead, AI provider failover, idempotency keys, locks,
  event bus, queue + dead-letter list, saga, feature flags.
- Security: security headers/CSP, origin check, SSRF guard, webhook signature verification, structured redacted logging.
- Observability: health/readiness/metrics endpoints, tracing headers, SLI/SLO helpers.
- Self-host server, Dockerfile, Kubernetes + Helm, Terraform, nginx, CI/CD workflows, runbooks.
- Migration `202610240001_job_matches.sql`, `202610270001_performance_indexes.sql`.
### Changed
- Unknown server errors return a generic message plus a request id instead of internal details.

## 0.1.0
- Initial Clario: upload, extraction, resume analysis, chat, charts, exports.
