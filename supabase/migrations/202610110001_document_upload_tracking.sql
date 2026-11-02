-- Milestone 3: track upload lifecycle and real file size.
-- Additive only — does not alter the Milestone 2 migration.

alter table public.documents
  add column status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  add column file_size bigint not null default 0 check (file_size >= 0 and file_size <= 26214400);

-- Existing rows (none expected before Milestone 3, but just in case) keep
-- the backfilled default; every new insert from here on must state a real
-- size explicitly.
alter table public.documents
  alter column file_size drop default;

create index documents_user_status_created_idx
  on public.documents (user_id, status, created_at desc);
