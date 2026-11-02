# Clario operations guide

How Clario is run, watched and repaired. Every section says what exists in the code today and what is
only a procedure for you to follow.

## Contents
- [Architecture at a glance](#architecture-at-a-glance)
- [Health checks and probes](#health-checks-and-probes)
- [SLOs, SLIs and error budgets](#slos-slis-and-error-budgets)
- [Monitoring, logging, tracing, alerts](#monitoring-logging-tracing-alerts)
- [Deployments and rollbacks](#deployments-and-rollbacks)
- [Security hardening](#security-hardening)
- [Reliability patterns in the code](#reliability-patterns-in-the-code)
- [Backups, disaster recovery, failover, multi-region](#backups-disaster-recovery-failover-multi-region)
- [Chaos testing](#chaos-testing)
- [Cost, cold starts and serverless limits](#cost-cold-starts-and-serverless-limits)
- [On-call and incident response](#on-call-and-incident-response)
- [Runbooks](#runbooks)

## Architecture at a glance
Browser (React PWA) -> `/api/*` serverless functions (Vercel) or the self-host gateway (`server/`) ->
Supabase (Auth + Postgres with RLS + Storage), Upstash Redis (rate limits, cache, locks, queue, idempotency),
Groq or Claude (AI), free job boards (Remotive, Arbeitnow, Remote OK).
The server holds only the Supabase **anon** key and acts as each signed-in caller, so Row Level Security is
the last line of defence even if application code has a bug. There is no service-role key anywhere.

## Health checks and probes
| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /healthz` (self-host) / `GET /api/internal/health` | Process is alive. No dependencies touched. | liveness / startup probes, uptime monitors |
| `GET /readyz` (self-host) / `GET /api/internal/ready` | Config, Redis and Supabase reachable. 503 while draining. | readiness probe, deploy smoke test |
| `GET /api/internal/metrics` | Prometheus text. Needs `Authorization: Bearer $METRICS_TOKEN`; 404 if the token is unset. | Prometheus |
| `GET /api/internal/warm-feeds` | Refreshes job-board caches. Needs `Bearer $CRON_SECRET`; leader-locked so replicas do not double-run. | Vercel cron / K8s CronJob |

Liveness deliberately ignores dependencies: restarting healthy pods because Redis blipped makes outages worse.

## SLOs, SLIs and error budgets
| SLI | Measured as | SLO (30 days) |
|---|---|---|
| Availability | non-5xx responses / all responses | 99.5% (about 3.6 h of failure budget) |
| Latency | share of requests finishing under 1.5 s | 95% |

AI generation endpoints are slow by nature (several seconds); judge them by the latency histogram per route,
not the global SLI, when investigating. `GET /api/internal/metrics?format=json` returns the live SLI snapshot and
remaining error budget (`api/_lib/metrics.ts`: `sliSnapshot`, `errorBudget`). Alerts in `deploy/prometheus/alerts.yaml`
page on fast budget burn (14x the allowed rate) and open a ticket on slow burn.
Policy: if more than half the monthly budget is spent, pause feature releases and fix reliability first.

## Monitoring, logging, tracing, alerts
- **Logs**: one JSON line per event (`api/_lib/logger.ts`), with request id, trace id and user id attached
  automatically. Authorization headers, tokens, keys, passwords and resume text are redacted by key name.
  Set `LOG_LEVEL=debug|info|warn|error`. On Vercel read them in the project's Logs tab.
- **Tracing**: W3C `traceparent` is accepted, generated and forwarded to outbound calls (`api/_lib/tracing.ts`).
  `X-Request-Id` is returned on every response, and also appears in 500 bodies, so a user report can be matched to logs.
- **Metrics**: request counts and latency histogram per route template (ids collapsed), retries, breaker openings.
- **Alerts**: see `deploy/prometheus/`. Not deployed by this repo; you need a Prometheus (or Grafana Cloud free tier)
  scraping the metrics endpoint. On Vercel without Prometheus, use an external uptime monitor on `/api/internal/health`
  and Vercel's built-in alerts.

## Deployments and rollbacks
- **CI** (`.github/workflows/ci.yml`): typecheck, tests, migration check, builds, `npm audit`, Docker build. Dependency
  cache keyed on `package-lock.json`.
- **Vercel**: previews on pull requests, production from `main` after CI (`deploy.yml`), smoke test after deploy.
  **Rollback**: Vercel dashboard -> Deployments -> previous -> Promote, or run the *Deploy* workflow with `action=rollback`.
  Database migrations are additive and forward-only: never roll a deployment back past a migration that
  removed something it needs. Ship destructive changes in two releases (stop using, then drop).
- **Rolling / blue-green / canary on Kubernetes**: `deploy/k8s/README.md`.
- **Percentage rollouts without redeploying**: `FEATURE_<NAME>=on|off|<0-100>` (stable hash per user, so the same users
  stay in the canary). Example: `FEATURE_JOB_SUGGESTIONS=10`. Browser flags use `VITE_FEATURE_*` (build time).

## Security hardening
Implemented in code, tested in `api/_lib/__tests__` and `server/__tests__`:
- Auth on every route (`requireAuth`), identifiers checked against the caller, RLS in Postgres.
- Per-user and per-IP rate limiting, backpressure (503) when overloaded, request timeouts.
- Input validation and bounded bodies; uploads limited by type and size; filenames sanitised.
- Security headers + CSP (`server/security.ts` is the single source; `vercel.json` is generated from it:
  `scripts/gen-vercel-json.mjs`; a test fails if they drift). HSTS only over HTTPS.
- Origin check on state-changing requests (`api/_lib/security.ts`); the API uses bearer tokens, not cookies, so CSRF is
  not exploitable, and the origin check is defence in depth.
- SSRF guard for any user-influenced outbound URL (`api/_lib/ssrf.ts`).
- Webhook signature verification with timestamp tolerance (`api/_lib/webhooks.ts`) - ready for when a webhook endpoint is added.
- Optional Cloudflare Turnstile CAPTCHA on sign-up (`VITE_TURNSTILE_SITE_KEY`; enable the matching setting in Supabase Auth).
- Audit log of sensitive actions as structured log lines (`api/_lib/audit.ts`).
- Private storage bucket; time-limited signed URLs.

Things only you can do: rotate any key that was ever pasted in chat; enable MFA on GitHub, Vercel, Supabase, Upstash;
turn on Supabase's leaked-password protection; keep `.env` out of git; set `CRON_SECRET` and `METRICS_TOKEN` (long random).
Secrets management: environment variables in Vercel / Kubernetes Secrets, never in the repo or the image. Rotate on a schedule.
JWT rotation: Supabase issues short-lived access tokens refreshed automatically; rotate the project JWT secret from
the Supabase dashboard if it leaks (this signs everyone out).
Encryption: TLS in transit (Vercel/ingress terminate HTTPS; Supabase and Upstash are HTTPS-only); at rest is provided by
Supabase, Upstash and the storage provider. WAF/DDoS: provided by Vercel's edge or Cloudflare in front of the self-host server; the app adds rate limits.

## Reliability patterns in the code
Timeouts, retries with exponential backoff and jitter, circuit breaker, bulkhead, failover between AI providers
(`AI_FALLBACK_PROVIDER`), idempotency keys, distributed locks, leader election, saga with compensation, an event bus,
a Redis queue with a dead-letter list, caching with stale fallback. File map: `docs/ARCHITECTURE-CHECKLIST.md`.

## Backups, disaster recovery, failover, multi-region
- **Postgres**: Supabase free projects do **not** include point-in-time recovery. Run a scheduled `pg_dump`
  (for example a weekly GitHub Action with a read-only DB URL stored as a secret, uploaded to private storage) and
  test a restore into a scratch project at least quarterly. Paid plans add daily backups and PITR.
- **Objects**: uploaded files live in a private bucket; Redis holds only disposable data (caches, counters, locks).
- **Targets** (suggested): RPO 24 h on the free tier (1 h with PITR), RTO 4 h.
- **Failover**: AI provider failover is automatic in code. Database failover is the provider's. Rebuild plan if a host is lost:
  new Supabase project -> run `supabase/migrations/*` in order -> restore dump -> point env vars -> redeploy.
- **Multi-region**: not implemented; single-region keeps the free-tier stack simple. If needed: Vercel multi-region
  functions + Supabase read replicas (paid) - see checklist. Network partitions and clock skew are handled by timeouts,
  idempotent retries, lock TTLs (never clock-compared between machines) and Redis time for expirations.

## Chaos testing
Non-production only (ignored when `NODE_ENV=production`): `CHAOS_FAILURE_RATE=0.3` fails 30% of outbound calls,
`CHAOS_LATENCY_MS=2000` slows them. Run the app locally and confirm: retries happen, the breaker opens, the AI
provider falls back, pages show friendly errors. Do this before big releases.

## Cost, cold starts and serverless limits
- Free tiers: Vercel Hobby, Supabase, Upstash, Groq. Job feeds are cached (8 h fresh, 3 days stale) so a visitor never
  triggers a download storm; Remotive is limited to about 4 requests per day by its terms.
- **Cold starts**: the first request after idle loads the function. Imports are kept lean; clients are created lazily;
  the 8-hourly cron also keeps one function warm. Measure with the latency histogram's p99.
- **Serverless limits**: Vercel Hobby allows **12 functions per deployment**; the project uses exactly 12
  (`server/__tests__` fails if more are added - put new endpoints into an existing dynamic route or under `api/_lib/`).
  Function duration and body size limits depend on plan; the app caps request time (`REQUEST_TIMEOUT_MS`, default 25 s) and bodies (2 MB).
- Cheap by design: matching is local code, one AI call per resume analysis, results stored so they are not recomputed.

## On-call and incident response
Solo project: you are on call. Make it survivable: uptime monitor texts you only for page-level alerts; everything
else is a ticket for office hours. Severity: **SEV1** site down or data exposed; **SEV2** major feature broken;
**SEV3** degraded or cosmetic.
1. Acknowledge, note the start time. 2. **Mitigate first** (roll back, flip a feature flag to `off`, disable a provider), diagnose after.
3. Find the request id in logs. 4. Communicate (status note if users are affected). 5. Write a postmortem within 5 days
(`docs/POSTMORTEM_TEMPLATE.md`), blameless, with action items that have owners and dates.
Suspected key leak: rotate the key first, then investigate.

## Runbooks
### Runbook: site down
Check Vercel status and the latest deployment. If the last deploy is recent, roll back. Check `/api/internal/health`
(function alive?) and `/api/internal/ready` (which dependency failed?). Supabase or Upstash status pages next.

### Runbook: high error rate
Open logs filtered to `level=error`, group by route. One route -> recent change to it: roll back or flip its flag.
All routes -> dependency (readiness check names it). Circuit breaker open means a provider is failing; failover should already be serving.

### Runbook: slow responses
Compare per-route latency. AI routes slow -> provider latency (try `AI_FALLBACK_PROVIDER`). All routes slow -> Redis/Supabase latency,
cold starts after idle, or the in-flight cap being hit (503s). Check the slow query list in Supabase and that
`202610270001_performance_indexes.sql` is applied.

### Runbook: AI provider or job board outage
Breakers open and fall back automatically; job feeds serve stale cache for up to 3 days. Users see a note when data is stale.
Nothing to do unless it lasts days: switch `AI_PROVIDER`, or turn the feature off with its flag.

### Runbook: memory growth
Node's garbage collector frees unreachable memory, so growth means something is still referenced. Check
`process_resident_memory_bytes` over time; usual causes are unbounded Maps/arrays. Caches here are size-capped; restart as a stop-gap and
take a heap snapshot (`node --inspect`) to find the retainer.

### Runbook: rate-limit complaints
Limits are in `api/_lib/rateLimit.ts`. Raise one value and redeploy, or clear a key in Upstash. Fail-open if Redis is down.
