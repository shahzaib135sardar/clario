# Architecture and security checklist

Every item you listed, with an honest status. Status keys:

- **Done** - implemented in this repo and covered by unit tests (file given).
- **Done (untested live)** - implemented, but it needs a real service (Supabase, Redis, Groq, job boards) that the build environment could not reach, so only its logic is unit tested.
- **Platform** - provided by Vercel, Supabase, Upstash or the browser; nothing to implement, listed so you know where it lives.
- **Written, not run** - a config/manifest/workflow is in the repo but was never executed against real infrastructure (no cluster, no Terraform/Helm binaries, no Docker daemon, no GitHub runner here). Review before relying on it.
- **Procedure** - described in `docs/OPERATIONS.md` for you to follow; no code.
- **Not implemented** - deliberately skipped, with the reason.

## A. The 19 "security holes" from your screenshot

| # | Item | Status | Where / note |
|---|---|---|---|
| 1 | RLS on every table | Done (untested live) | `supabase/migrations/*`; server uses only the anon key scoped to the caller, so RLS always applies |
| 2 | Auth on every route | Done | `requireAuth` in every handler under `api/` (except the token-guarded `internal/` probes) |
| 3 | Never trust the frontend | Done | Server re-validates bodies, ids, file size/type; ownership checked server-side (`api/_lib/validation.ts`, `artifactSchemas.ts`) |
| 4 | Rate limiting | Done | `api/_lib/rateLimit.ts` per user; per-IP in `server/gateway.ts`; nginx edge limits |
| 5 | Sanitize input | Done | Length/shape validation, filename sanitising, AI output schema-validated; React escapes output; no `dangerouslySetInnerHTML` anywhere (searched) |
| 6 | Parameterized queries | Done | Only supabase-js query builder is used; no string-built SQL or `rpc` calls (searched) |
| 7 | CORS lockdown | Done | `api/_lib/security.ts` (`isOriginAllowed`, `TRUSTED_ORIGINS`), `server/security.ts` |
| 8 | HTTPS | Platform + Done | Vercel/ingress terminate TLS; HSTS and `upgrade-insecure-requests` sent over HTTPS; outbound calls must be https (`ssrf.ts`) |
| 9 | IDOR | Done | Every query filters by `user_id` as well as id, returns 404 for other people's ids; ids must be UUIDs (`isUuid`, added in this review) |
| 10 | Debug off in production | Done | Unknown errors return a generic message + request id (`http.ts`); chaos injection ignored when `NODE_ENV=production`; logs redact secrets |
| 11 | CAPTCHA | Done (untested live) | Optional Turnstile on sign-up: `src/components/Turnstile.tsx`, `VITE_TURNSTILE_SITE_KEY`; also switch on CAPTCHA in Supabase Auth |
| 12 | Log admin actions | Done | `api/_lib/audit.ts` writes structured audit lines for create/delete/generate events. The app has no admin role yet, so these are user actions |
| 13 | Private buckets | Done (untested live) | Storage is private; only short-lived signed URLs (`r2.ts`) |
| 14 | Hide admin pages | Not applicable | The app has no admin pages. Internal endpoints are disabled unless `METRICS_TOKEN` / `CRON_SECRET` is set, and nginx blocks `/api/internal/` publicly |
| 15 | Update vulnerable packages | Done + Procedure | `npm audit` run; Dependabot config; CI audit. One advisory remains (`image-size` via `pptxgenjs`, DoS when measuring images). The deck code never embeds images, so it is not reachable; the suggested fix is a downgrade, so it was not forced |
| 16 | File upload checks | Done | Size limit, MIME allow-list, magic-byte sniffing after upload (`shared/fileRules.ts`, `confirm.ts`) |
| 17 | Claude security review | Done (this document) | Manual review of auth, IDOR, injection, uploads, SSRF, headers, secrets; finding fixed: URL ids were not format-checked. Not a substitute for an independent pentest |
| 18 | Security headers | Done | CSP, HSTS, nosniff, frame-deny, referrer, permissions, COOP: `server/security.ts` -> `vercel.json` (test keeps them identical) |
| 19 | Verify webhook signatures | Done | `api/_lib/webhooks.ts` (HMAC, constant-time compare, timestamp tolerance, replay hook). There is no incoming webhook route yet, so nothing calls it today |

## B. Your 111 items

| # | Item | Status | Where / note |
|---|---|---|---|
| 1 | Rate Limiting | Done | `rateLimit.ts`, `server/gateway.ts` |
| 2 | Caching | Done | Job feeds cached in Redis with stale fallback (`jobSources.ts`); HTTP cache headers |
| 3 | Load Balancing | Platform / Written, not run | Vercel balances itself; `deploy/nginx/nginx.conf` (least_conn), K8s Service |
| 4 | Reverse Proxies | Written, not run | nginx config; gateway honours `X-Forwarded-*` only with `TRUST_PROXY` (tested) |
| 5 | API Gateways | Done | `server/` gateway: routing, request ids, headers, rate limit, backpressure, health, graceful shutdown |
| 6 | CI/CD | Written, not run | `.github/workflows/ci.yml`, `deploy.yml`, `preview.yml` |
| 7 | Docker | Written, not run | `Dockerfile`, `.dockerignore`, `docker-compose.yml`; the bundled server itself was started and smoke-tested locally |
| 8 | Kubernetes | Written, not run | `deploy/k8s/*` (YAML parses; never applied to a cluster) |
| 9 | Service Discovery | Platform | Kubernetes/Compose DNS; the app is a single service so needs none of its own |
| 10 | Circuit Breakers | Done | `resilience.ts` `CircuitBreaker` |
| 11 | Timeouts | Done | `withTimeout`, `REQUEST_TIMEOUT_MS`, client 30s/90s |
| 12 | Retries | Done | `retry`, `resilientFetch`, `src/lib/retry.ts` |
| 13 | Exponential Backoff | Done | `backoffDelay` with full jitter, Retry-After honoured |
| 14 | Idempotency | Done | `idempotency.ts`; browser sends `Idempotency-Key` on POST |
| 15 | Message Queues | Done (library only) | `queue.ts` (Redis list, retries). No feature enqueues work yet; nothing in the app needs background jobs today |
| 16 | Pub/Sub | Done (single process) | `events.ts` in-process event bus. Not cross-instance |
| 17 | Event-Driven Architecture | Done (light) | Handlers emit events; audit subscribers react |
| 18 | Distributed Transactions | Not implemented | No two-phase commit; the saga approach is used instead |
| 19 | Saga Pattern | Done | `saga.ts`, used when creating a document (row + upload URL, compensating delete) |
| 20 | Dead Letter Queues | Done (library only) | `queue.ts` `listDead` / `requeueDead` |
| 21 | Cron Jobs | Done / Written, not run | `vercel.json` cron + `warm-feeds`; K8s `cronjob.yaml` |
| 22 | WebSockets | Not implemented | Request/response is enough; no live push needed |
| 23 | Long Polling | Not implemented | Not needed |
| 24 | Server-Sent Events | Not implemented | AI replies are returned whole, not streamed. Streaming would be a future feature |
| 25 | Database Indexing | Done | `202610270001_performance_indexes.sql` |
| 26 | Query Optimization | Done | Column-limited selects, `.limit(200)` on lists, one query per list |
| 27 | N+1 Queries | Done | List endpoints use single queries; no per-row lookups |
| 28 | Connection Pooling | Platform | supabase-js talks HTTP to PostgREST, which Supabase pools; no direct DB connections from the app |
| 29 | Read Replicas | Not implemented | Paid Supabase feature; unnecessary at this scale |
| 30 | Sharding | Not implemented | Unnecessary at this scale |
| 31 | Partitioning | Not implemented | Unnecessary at this scale |
| 32 | Replication | Platform | Handled by Supabase / Upstash |
| 33 | Leader Election | Done | `locks.ts` `runAsLeader`, used by `warm-feeds` |
| 34 | CAP Theorem | Design decision | Postgres is the source of truth (consistent); Redis caches favour availability (stale reads allowed); the rate limiter fails open if Redis is down |
| 35 | Eventual Consistency | Done (by design) | Cached feeds and stored job matches may be up to hours old, and say so |
| 36 | Optimistic Locking | Not implemented | No concurrent-edit workflow exists (rows are append-only artifacts) |
| 37 | Pessimistic Locking | Done (Redis only) | `withLock`; no database row locks are used |
| 38 | Distributed Locks | Done | `locks.ts` SET NX PX, owner-checked release |
| 39 | Race Conditions | Done | Idempotency keys, locks, feed stampede protection (`jobSources.ts`) |
| 40 | Deadlocks | Design | Locks have TTLs and are never nested |
| 41 | Memory Leaks | Done (partial) | Caches and metric label sets are bounded; memory gauge + alert + runbook. No leak detector |
| 42 | Garbage Collection | Platform | V8's; heap gauge exposed |
| 43 | Thread Safety | Design | Node is single-threaded per instance; no shared mutable state across requests except bounded caches |
| 44 | Backpressure | Done | Bulkhead (`resilience.ts`) and in-flight cap -> 503 + Retry-After (`server/gateway.ts`) |
| 45 | Autoscaling | Platform / Written, not run | Vercel scales automatically; `deploy/k8s/hpa.yaml` |
| 46 | Horizontal Scaling | Done | Stateless app; shared state lives in Redis/Postgres |
| 47 | Vertical Scaling | Platform | Plan / resource limits |
| 48 | CDN | Platform | Vercel's edge network; immutable cache headers on hashed assets |
| 49 | Edge Caching | Platform | Same; API responses are `no-store` on purpose |
| 50 | Cache Invalidation | Done | TTLs, forced refresh, hashed asset names, service-worker cache versioning |
| 51 | Feature Flags | Done | `api/_lib/featureFlags.ts`, `src/lib/featureFlags.ts` |
| 52 | Blue-Green Deployment | Procedure | `deploy/k8s/README.md`; on Vercel, preview + Promote |
| 53 | Canary Releases | Done (flags) + Procedure | Percentage flags with stable per-user cohorts; K8s notes |
| 54 | Rolling Deployments | Platform / Written, not run | K8s `RollingUpdate` (`maxUnavailable: 0`) |
| 55 | Rollbacks | Written, not run | `deploy.yml` rollback job, `kubectl rollout undo`, Vercel Promote |
| 56 | Health Checks | Done | `/api/internal/health`, `/healthz` |
| 57 | Liveness & Readiness Probes | Done / Written, not run | `internal/ready`, `/readyz`; probes in `deployment.yaml` |
| 58 | Monitoring | Done (code) + Procedure | Metrics endpoint; you must run a Prometheus or uptime monitor |
| 59 | Logging | Done | `logger.ts` JSON with redaction and request context |
| 60 | Distributed Tracing | Done (propagation only) | `tracing.ts` W3C `traceparent` in/out; no tracing backend is set up |
| 61 | Metrics | Done | `metrics.ts`, Prometheus format |
| 62 | Alerts | Written, not run | `deploy/prometheus/alerts.yaml` |
| 63 | SLOs | Done | `docs/OPERATIONS.md`, `metrics.ts` defaults |
| 64 | SLIs | Done | `sliSnapshot` |
| 65 | Error Budgets | Done | `errorBudget`, burn-rate alert |
| 66 | Observability | Done (code) | Logs + metrics + trace ids together |
| 67 | Secrets Management | Done + Procedure | Env-only secrets, redaction, `.gitignore`, check scripts, K8s Secret template; rotation is on you |
| 68 | IAM | Platform | Supabase auth + RLS; storage keys should be scoped to the one bucket |
| 69 | OAuth | Done (untested live) | Google sign-in via Supabase |
| 70 | JWT Rotation | Platform | Supabase short-lived tokens auto-refresh; secret rotation is a dashboard action |
| 71 | TLS | Platform | Vercel / ingress; HSTS header |
| 72 | Encryption at Rest | Platform | Supabase, Upstash, storage provider |
| 73 | Encryption in Transit | Platform + Done | HTTPS everywhere; outbound http refused by the SSRF guard |
| 74 | WAF | Not implemented | Use Vercel Firewall or Cloudflare in front; the app has app-level limits only |
| 75 | DDoS Protection | Platform | Vercel/Cloudflare edge; rate limits and backpressure behind it |
| 76 | CORS | Done | See A7 |
| 77 | CSRF | Done | Bearer-token API (no cookies), plus Origin check |
| 78 | SQL Injection | Done | See A6 |
| 79 | XSS | Done | React escaping, CSP, no raw HTML injection |
| 80 | SSRF | Done | `ssrf.ts`, applied to the external chatbot URL |
| 81 | Database Migrations | Done | `supabase/migrations`, `scripts/check-migrations.mjs` (tested) |
| 82 | Schema Versioning | Done | Timestamped, ordered migration files, checked in CI |
| 83 | Disaster Recovery | Procedure | `docs/OPERATIONS.md` |
| 84 | Backups | Procedure | No automated backup job is written; free Supabase has no PITR |
| 85 | Failover | Done (AI) / Platform (DB) | `withFailover` between providers |
| 86 | Multi-Region Deployment | Not implemented | Single region by design |
| 87 | Chaos Engineering | Done | `maybeInjectChaos` (non-production only) |
| 88 | Cost Optimization | Done | Cached feeds, local matching, one AI call per analysis, free-tier friendly |
| 89 | Cold Starts | Done (mitigation) | Lazy init, lean imports, cron warms one instance. Not measurable here |
| 90 | Serverless Limits | Done | Exactly 12 functions (test enforces <= 12); timeouts and body caps |
| 91 | Latency | Done | Per-route histogram |
| 92 | Throughput | Done | Request counters (rate in Prometheus) |
| 93 | P99 Latency | Done | `percentileFromBuckets`, alert |
| 94 | Tail Latency | Done (partial) | Timeouts, no retry on timeout; request hedging not implemented |
| 95 | Network Partitions | Done (design) | Timeouts, breakers, idempotent retries, fail-open/closed choices documented |
| 96 | Clock Skew | Done | Webhook tolerance window; lock/cache expiry uses Redis-side TTLs |
| 97 | DNS | Done (narrow) | SSRF guard resolves hostnames and rejects private results; otherwise platform |
| 98 | TCP vs UDP | Not applicable | Everything is HTTP over TCP |
| 99 | HTTP/2 & HTTP/3 | Platform | Vercel serves h2/h3; the nginx sample is plain HTTP/1.1 behind a TLS terminator |
| 100 | gRPC | Not implemented | A single web client; REST is enough |
| 101 | Webhooks | Done (verification) | `webhooks.ts`; no webhook endpoints exist yet |
| 102 | API Versioning | Done | `/api/v1/*` alias (Vercel rewrite and gateway) |
| 103 | Semantic Versioning | Done | `0.2.0`, `CHANGELOG.md` |
| 104 | Infrastructure as Code | Written, not run | `deploy/` |
| 105 | Terraform | Written, not run | `deploy/terraform` (Vercel provider; no `terraform validate` was possible) |
| 106 | Helm Charts | Written, not run | `deploy/helm/clario` (no `helm lint` was possible) |
| 107 | Build Caching | Written, not run | npm cache and Docker layer cache in CI |
| 108 | Dependency Hell | Done | Lockfile, Dependabot, audit; see A15 |
| 109 | Production Incidents | Procedure | `docs/OPERATIONS.md` |
| 110 | On-Call | Procedure | `docs/OPERATIONS.md` |
| 111 | Postmortems | Procedure | `docs/POSTMORTEM_TEMPLATE.md` |

## What was verified, and what was not

Verified here: TypeScript compiles; the full test suite passes; the web app and the self-host server build; the bundled server starts, serves the app, applies headers, routes `/api`, reports not-ready when its config is missing, and drains on SIGTERM; all YAML parses; `vercel.json` is valid JSON and matches the server's CSP.

Never exercised against the real thing: Supabase, Upstash, Groq/Claude, the job boards, Vercel itself, GitHub Actions, Docker image build, Kubernetes, Helm, Terraform, Prometheus. Expect small fixes when you first run those.
