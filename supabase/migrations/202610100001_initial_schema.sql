create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_name text not null,
  file_type text not null check (
    file_type in (
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  ),
  storage_key text,
  extracted_text text not null,
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table public.generated_artifacts (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('summary', 'chart', 'plan', 'ppt')),
  content jsonb,
  storage_key text,
  created_at timestamptz not null default now(),
  constraint generated_artifacts_content_location check (
    (kind = 'ppt' and storage_key is not null)
    or (kind <> 'ppt' and content is not null)
  )
);

create index documents_user_created_idx
  on public.documents (user_id, created_at desc);
create index chat_messages_document_created_idx
  on public.chat_messages (document_id, created_at);
create index chat_messages_user_created_idx
  on public.chat_messages (user_id, created_at desc);
create index generated_artifacts_document_created_idx
  on public.generated_artifacts (document_id, created_at desc);
create index generated_artifacts_user_created_idx
  on public.generated_artifacts (user_id, created_at desc);

alter table public.documents enable row level security;
alter table public.chat_messages enable row level security;
alter table public.generated_artifacts enable row level security;

revoke all on public.documents, public.chat_messages, public.generated_artifacts from anon;
grant select, insert, update, delete
  on public.documents, public.chat_messages, public.generated_artifacts
  to authenticated;

create policy "documents_owner_all"
  on public.documents
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "chat_messages_owner_all"
  on public.chat_messages
  for all
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = (select auth.uid())
    )
  );

create policy "generated_artifacts_owner_all"
  on public.generated_artifacts
  for all
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = (select auth.uid())
    )
  );