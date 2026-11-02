-- Milestones 4-6 + resume analyzer: generated_artifacts needs one more
-- `kind` so resume-fit analysis can be stored alongside summaries, charts,
-- plans, and decks. Additive only — existing rows, policies, and the
-- Milestone 2/3 migrations are untouched.

alter table public.generated_artifacts
  drop constraint generated_artifacts_kind_check;

alter table public.generated_artifacts
  add constraint generated_artifacts_kind_check
  check (kind in ('summary', 'chart', 'plan', 'ppt', 'resume_analysis'));

-- Fetching "the latest artifact of this kind for this document" is the
-- shape every generation route queries in, so index for it directly.
create index if not exists generated_artifacts_document_kind_created_idx
  on public.generated_artifacts (document_id, kind, created_at desc);
