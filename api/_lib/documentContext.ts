import type { SupabaseClient } from '@supabase/supabase-js'
import { sendError, type ApiResponse } from './http'
import type { DocumentStatus } from './documents'

// Bounds how much extracted document text ever goes into one prompt. This
// app does no chunking or embeddings-based retrieval (not part of the
// fixed stack) — for documents longer than this, the model only ever sees
// the leading portion. That's a real, known limitation for very long
// documents; see the README.
export const DOCUMENT_CONTEXT_CHAR_LIMIT = 12_000

export type DocumentWithText = {
  id: string
  file_name: string
  file_type: string
  status: DocumentStatus
  extracted_text: string
}

/**
 * Loads one document scoped to its owner (RLS enforces this independently)
 * and confirms it has actually finished uploading. Writes the appropriate
 * error response and returns null when the document can't be used yet, so
 * a route can simply `if (!doc) return` right after calling this.
 */
export async function loadReadyDocumentWithText(
  client: SupabaseClient,
  res: ApiResponse,
  userId: string,
  documentId: string,
): Promise<DocumentWithText | null> {
  const { data, error } = await client
    .from('documents')
    .select('id, file_name, file_type, status, extracted_text')
    .eq('id', documentId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('documents:load-with-text', error)
    sendError(res, 500, 'Could not load this document.')
    return null
  }
  if (!data) {
    sendError(res, 404, 'Document not found.')
    return null
  }

  const row = data as DocumentWithText
  if (row.status !== 'ready') {
    sendError(res, 409, 'This document is still being processed. Try again shortly.')
    return null
  }
  return row
}

/** Bounds how much of a document's text is handed to a prompt. */
export function truncateForContext(
  text: string,
  limit: number = DOCUMENT_CONTEXT_CHAR_LIMIT,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}
