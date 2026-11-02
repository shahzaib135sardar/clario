# Clario

Clario is a document-intelligence workspace for turning business, research, legal, technical, and other documents into useful answers and work products.

## What's implemented

| Milestone | Status |
| --- | --- |
| 1. Frontend shell | Complete |
| 2. Supabase auth, schema, RLS | Complete |
| 3. Client-side extraction, validated private R2 uploads, real listing/deletion | Complete |
| 4. Authenticated, rate-limited, document-grounded chat | Complete |
| 5. AI summaries, charts (Recharts), action plans | Complete |
| 6. Editable PowerPoint generation (pptxgenjs) | Complete |
| Extra: Resume analyzer (Groq) | Complete |
| Extra: Job suggestions from free job boards | Complete |
| Extra: Pluggable external chatbot provider | Complete |
| Extra: Separate Resume / Jobs / AI chat (locked) sections, split Settings, installable mobile PWA | Complete |
| Extra: Security headers, rate limits, idempotency, resilience, observability, self-host server, Docker/K8s/CI files | Complete in code; deploy files not run against real infrastructure |

Code is written and type-checked, and pure-logic tests pass. **The AI, R2, Upstash, and Supabase calls have never been exercised against live services from the build environment** — see [Before you launch](#before-you-launch).

## Run locally

Requirements: Node.js 20.19+ or 22.12+, and npm.

```bash
npm install
cp .env.example .env   # then fill in the values described below
npm run dev
```

`npm run dev` serves the frontend only. The `api/` routes are Vercel-style Node serverless functions; to exercise them locally use `vercel dev` (Vercel CLI) or a preview deployment.

> **Build-time environment variables matter.** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are inlined into the bundle at build time. If they're unset when `vite build` runs, the bundler constant-folds the "is Supabase configured" check and **tree-shakes the entire authenticated app out of the production bundle**. `npm run dev` still works, which hides the problem. On your deploy platform, set both as real build-time environment variables, then verify with `npm run build && npm run preview`.

## Supabase setup

1. Create a project; set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (browser) and `SUPABASE_URL` / `SUPABASE_ANON_KEY` (server — same project, same anon key).
2. In the SQL Editor, run the migrations **in order**:
   - `supabase/migrations/202610100001_initial_schema.sql` — tables + RLS
   - `supabase/migrations/202610110001_document_upload_tracking.sql` — upload `status` / `file_size`
   - `supabase/migrations/202610120001_generation_features.sql` — adds the `resume_analysis` artifact kind
   - `supabase/migrations/202610240001_job_matches.sql` — adds the `job_matches` artifact kind (job suggestions)
   - `supabase/migrations/202610270001_performance_indexes.sql` — indexes for the list and lookup queries (safe to re-run)
3. Enable email/password and Google auth; set the site URL and redirect allow-list for local and production URLs.

The server uses the anon key scoped to each caller's own access token — never a service-role key — so every query still passes through RLS.

## Environment variables

Never commit `.env`. Never put secrets in `VITE_` variables. The file must be named exactly `.env` (Vite and `vercel dev` ignore `.env.example`), and the dev server must be restarted after every change.

Not sure a value is right? `node scripts/check-env.mjs` checks every line (missing values, a key pasted into a URL line, duplicate lines, wrong key type) and never prints a secret, so its output is safe to share.

To confirm the AI keys, models and billing actually work, run `node scripts/check-ai.mjs`. It sends one tiny test request to Anthropic and Groq and says which setting is wrong, without printing any key.

| Variable | Used for |
| --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Browser Supabase config (build-time) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Server Supabase config |
| `AI_PROVIDER` | `anthropic` (default) or `groq`. `groq` runs chat, summaries, charts, plans and decks on Groq's free tier; switch back to `anthropic` after adding Anthropic credit |
| `ANTHROPIC_API_KEY` | Claude (chat, summaries, charts, plans, deck outlines) |
| `ANTHROPIC_MODEL_CHAT` | Model ID for chat, e.g. `claude-haiku-5-5` |
| `ANTHROPIC_MODEL_GENERATION` | Model ID for summaries/charts/plans/decks, e.g. `claude-sonnet-5-5` |
| `GROQ_API_KEY`, `GROQ_MODEL` | Resume analyzer always; every AI feature when `AI_PROVIDER=groq` (default model `llama-3.3-70b-versatile`; run `node scripts/check-ai.mjs` to list the models your account can use) |
| `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` | Private S3-compatible bucket (Cloudflare R2, or Supabase Storage's S3 endpoint) |
| `S3_REGION`, `S3_FORCE_PATH_STYLE` | Leave blank for Cloudflare R2. For Supabase Storage set the project region and `true` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared rate-limit store |
| `CHAT_PROVIDER`, `EXTERNAL_CHATBOT_URL`, `EXTERNAL_CHATBOT_API_KEY` | Optional own-chatbot routing |
| `VITE_FEATURE_AI_CHAT` | Browser, build-time. `true` unlocks the AI chat sidebar page (default locked, shows "Soon") |
| `VITE_TURNSTILE_SITE_KEY` | Browser, optional. Adds a Cloudflare Turnstile CAPTCHA to sign-up (also enable CAPTCHA in Supabase Auth) |
| `FEATURE_<NAME>` | Server feature flags: `on`, `off` or a percentage `0-100`. Example `FEATURE_JOB_SUGGESTIONS=25` |
| `AI_FALLBACK_PROVIDER` | Optional second AI provider (`groq` or `anthropic`) used automatically when the first is failing |
| `TRUSTED_ORIGINS` | Optional comma-separated extra browser origins allowed to call the API (same-origin always allowed) |
| `CRON_SECRET` | Long random string. Vercel sends it to the cron that keeps job feeds warm; without it `/api/internal/warm-feeds` is disabled |
| `METRICS_TOKEN` | Long random string guarding `/api/internal/metrics`; without it that endpoint is disabled |
| `REQUEST_TIMEOUT_MS`, `LOG_LEVEL` | Optional: API handler timeout (default 25000) and log verbosity (`info`) |
| `CHAOS_FAILURE_RATE`, `CHAOS_LATENCY_MS` | Optional, non-production only: inject outbound failures/latency to test resilience |
| `PORT`, `STATIC_DIR`, `TRUST_PROXY`, `MAX_IN_FLIGHT`, `GATEWAY_RATE_LIMIT_PER_MINUTE`, `SHUTDOWN_DRAIN_MS` | Self-host server only (Docker/Kubernetes); see `server/config.ts` |

## API routes

All routes require `Authorization: Bearer <Supabase access token>`, verify ownership, and are rate-limited via Upstash.

| Route | Purpose |
| --- | --- |
| `GET/POST /api/documents` | List; create row + signed R2 upload URL |
| `POST /api/documents/:id/confirm` | Re-verify the uploaded object (size + signature) |
| `GET/DELETE /api/documents/:id` | Read; delete (R2 objects first — original and generated decks — then row) |
| `GET/POST /api/documents/:id/chat` | History; send message, get grounded reply |
| `GET/POST /api/documents/:id/summary` · `chart` · `plan` | Latest; generate |
| `GET/POST /api/documents/:id/pptx` | Latest signed download URL; generate and store deck |
| `GET/POST /api/documents/:id/resume-analysis` | Latest; analyze against a pasted job description |
| `GET/POST /api/documents/:id/jobs` | Latest saved job suggestions; find jobs for this resume |
| `GET /api/usage` | Real counts for dashboard/settings |
| `GET /api/internal/health` · `ready` · `metrics` · `warm-feeds` | Probes, Prometheus metrics (bearer `METRICS_TOKEN`), job-feed cron (bearer `CRON_SECRET`) |

Every route is also reachable as `/api/v1/...`. `POST` routes accept an optional `Idempotency-Key` header (a retried request replays the first result). Vercel's Hobby plan allows 12 functions; the project uses exactly 12, so add new endpoints inside an existing dynamic route or under `api/_lib/`.

## How the AI features work

One setting, `AI_PROVIDER`, decides which model answers chat, summaries, charts, plans and decks. `anthropic` (the default) uses Claude. `groq` sends the same prompts to Groq instead, which works on Groq's free tier but gives different (usually less polished) output, and structured results such as charts occasionally need a retry. The resume analyzer always uses Groq.

- **Chat** — the document's extracted text (first ~12,000 characters) plus the last 20 turns go to Claude with a "answer only from the document" prompt. There is no chunking or vector retrieval, so very long documents are only partly visible to the model.
- **Summary / chart / plan** — Claude returns strict JSON; `api/_lib/artifactSchemas.ts` validates every field before anything is saved or shown. Charts render with Recharts (lazy-loaded). If a document has no numeric data, the prompt asks for a theme-mention count instead; treat generated numbers as AI output, not verified figures.
- **PowerPoint** — Claude produces a slide outline (6–9 slides); `pptxgenjs` builds a real, editable `.pptx` server-side, stores it in R2, and returns a 5-minute signed download link.
- **Resume analyzer** — upload a resume as a normal document, paste a job description, get a score, strengths, gaps, missing keywords and suggestions from Groq. It's advisory, not a hiring decision tool.
- **Job suggestions** — under the resume analyzer, Clario lists open jobs that fit the selected resume, each with a "View job" link to the original listing. Groq reads the resume once and returns target job titles, skills and seniority; the app then scores listings from three free public boards (Remotive, Arbeitnow, Remote OK) by plain keyword overlap. The boards' full feeds are downloaded at most every 8 hours and cached in Upstash (an old copy is used if a board is down), so Remotive's "a few requests a day" guidance holds however many people use the app, and nothing from a resume is ever sent to a job board. Each link points at the listing page on the board that published it, which is the attribution those boards require; they are mostly remote roles, with Arbeitnow skewed toward Europe. LinkedIn and Google Jobs are not used: neither offers a free official API, and scraping them breaks their terms. Adding another board means one parser and one fetcher in `api/_lib/jobSources.ts`.

## Connecting your own chatbot

If you already host a chatbot behind an HTTP API:

1. Set `EXTERNAL_CHATBOT_URL` (and `EXTERNAL_CHATBOT_API_KEY` if it needs a bearer token) in your server environment.
2. Set `CHAT_PROVIDER=external`.
3. The default request is `POST { systemPrompt, message, history: [{role, content}] }` and it expects `{ "reply": "..." }` back. If your API differs, edit the one file `api/_lib/externalChatbot.ts` (request body and reply parsing).

Auth, ownership checks, rate limits, document grounding and message persistence stay identical — only the reply generator changes.

**On "training":** for question-answering over a user's own documents you generally do *not* retrain a model — the app supplies the document text at question time (retrieval-style grounding), which is what the chat route does. Fine-tuning is for changing a model's style or domain behavior using example conversations, and the resulting model must be hosted behind an inference endpoint (serverless functions can't run one). Fine-tune only if grounded prompting isn't enough.

## Tests and build

```bash
npm run test            # 270+ unit tests: validation, job matching, resilience, idempotency, locks, queue, saga, flags, security, gateway
npm run typecheck       # tsc -b
npm run check:migrations
npm run build           # tsc -b + vite build
npm run build:server && npm run start:server   # self-host gateway (see docs/OPERATIONS.md and deploy/)
```

Tests are pure logic; they do not call live services.

## Before you launch

Honest checklist of what still needs doing by you:

1. **Rotate any key ever pasted into a chat or committed anywhere** (including the Groq key).
2. Create accounts/resources: Supabase project (run all migrations), private R2 bucket (no public access; add a CORS rule allowing `PUT` from your site origin), Upstash Redis, Anthropic and Groq keys.
3. Set every variable above in your host (e.g. Vercel project settings), including the two `VITE_` ones as **build-time** variables.
4. **Smoke-test end to end on a preview deployment** — sign up, upload a PDF and DOCX, chat, generate summary/chart/plan, generate and open the `.pptx`, run the resume analyzer, delete a document and confirm the R2 objects are gone. None of this has been run against live services yet; expect to fix small integration issues (model IDs, CORS, serverless timeouts for PPTX/AI calls — raise the function timeout if generation is slow).
5. Known gaps, not done: no malware scanning of uploads, no content moderation, no billing/plans (the "2.8 / 10 GB" storage meter in the sidebar is still a static placeholder), no password/profile editing, scanned (image-only) PDFs aren't supported (no OCR), no browser end-to-end tests, no deployed monitoring (alert rules are written in `deploy/prometheus` but need a Prometheus), and the dashboard's remaining placeholder controls (filters, help center, notifications) are non-functional.
6. Review privacy/terms: documents are sent to the configured AI provider for processing (Anthropic by default, Groq when `AI_PROVIDER=groq`; resumes always go to Groq).

## More documentation

- `docs/ARCHITECTURE-CHECKLIST.md` — every item from the security and architecture lists: implemented (with file), provided by the platform, written but not run, or not applicable
- `docs/OPERATIONS.md` — SLOs, alerts, deployments, rollbacks, backups, incidents, runbooks
- `docs/MOBILE-AND-SHARING.md` — using Clario on iOS/Android and sharing it with friends
- `docs/POSTMORTEM_TEMPLATE.md`, `CHANGELOG.md`, `deploy/` (Docker, nginx, Kubernetes, Helm, Terraform, Prometheus)
