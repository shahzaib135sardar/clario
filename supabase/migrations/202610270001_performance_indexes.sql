-- Performance indexes. Additive only (create index if not exists); no data or
-- policies change. Each index names the query it serves (see api/**).

-- GET /api/documents: "this user's ready documents, newest first". RLS adds
-- user_id = auth.uid() to every query, so user_id leads the index. The partial
-- predicate keeps pending/failed rows (uploads that never finished) out of it.
create index if not exists documents_user_ready_created_idx
  on public.documents (user_id, created_at desc)
  where status = 'ready';

-- Usage counts (GET /api/usage) and the "latest artifact of kind X for this user"
-- reads count/select by (user_id, kind) and order by created_at.
create index if not exists generated_artifacts_user_kind_created_idx
  on public.generated_artifacts (user_id, kind, created_at desc);

-- Chat history (GET /api/documents/:id/chat) reads one document's messages in order;
-- RLS adds the user filter, so include user_id to keep the lookup index-only friendly.
create index if not exists chat_messages_document_user_created_idx
  on public.chat_messages (document_id, user_id, created_at);
