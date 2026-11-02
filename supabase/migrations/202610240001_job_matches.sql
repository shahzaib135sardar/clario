-- Job suggestions: one more generated_artifacts `kind` so the jobs found for
-- a resume can be saved next to its other generated content. Additive only —
-- existing rows, policies and earlier migrations are untouched.

alter table public.generated_artifacts
  drop constraint generated_artifacts_kind_check;

alter table public.generated_artifacts
  add constraint generated_artifacts_kind_check
  check (kind in ('summary', 'chart', 'plan', 'ppt', 'resume_analysis', 'job_matches'));
