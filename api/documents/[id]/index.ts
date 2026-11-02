import { isUuid } from '../../_lib/validation'
import {
  withErrorHandling,
  getPathSegments,
  requireMethod,
  sendError,
  sendJson,
  type ApiRequest,
  type ApiResponse,
} from '../../_lib/http'
import { requireAuth, requireRateLimit } from '../../_lib/guard'
import { emitEvent } from '../../_lib/events'
import { RATE_LIMITS } from '../../_lib/rateLimit'
import { deleteObject } from '../../_lib/r2'
import { DOCUMENT_SELECT_COLUMNS, toDocumentSummary, type DocumentRow } from '../../_lib/documents'

function getDocumentId(req: ApiRequest): string | null {
  const segments = getPathSegments(req)
  const index = segments.indexOf('documents')
  const id = index >= 0 ? segments[index + 1] : undefined
  return id ?? null
}

async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (!requireMethod(req, res, ['GET', 'DELETE'])) return

  const documentId = getDocumentId(req)
  if (!documentId || !isUuid(documentId)) {
    sendError(res, 400, 'Invalid document id.')
    return
  }

  const authed = await requireAuth(req, res)
  if (!authed) return
  const { client, user } = authed

  if (req.method === 'GET') {
    // RLS already scopes this to the caller's own rows; the explicit
    // .eq('user_id', ...) just makes a mismatch read as "not found" rather
    // than relying solely on the policy to produce an empty result.
    const { data, error } = await client
      .from('documents')
      .select(DOCUMENT_SELECT_COLUMNS)
      .eq('id', documentId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (error) {
      console.error('documents:get', error)
      sendError(res, 500, 'Could not load this document.')
      return
    }
    if (!data) {
      sendError(res, 404, 'Document not found.')
      return
    }

    sendJson(res, 200, { document: toDocumentSummary(data as DocumentRow) })
    return
  }

  // DELETE
  if (!(await requireRateLimit(res, RATE_LIMITS.documentDeletePerUser, user.id))) return

  const { data, error } = await client
    .from('documents')
    .select(DOCUMENT_SELECT_COLUMNS)
    .eq('id', documentId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    console.error('documents:delete:lookup', error)
    sendError(res, 500, 'Could not delete this document.')
    return
  }
  if (!data) {
    sendError(res, 404, 'Document not found.')
    return
  }

  const row = data as DocumentRow

  // Generated decks live in their own R2 objects. The database cascade
  // removes their rows when the document goes, but it can't reach R2 — so
  // collect their keys first and delete the objects explicitly, otherwise
  // they'd be orphaned in storage with nothing left pointing at them.
  const { data: pptRows, error: pptLookupError } = await client
    .from('generated_artifacts')
    .select('storage_key')
    .eq('document_id', documentId)
    .eq('user_id', user.id)
    .not('storage_key', 'is', null)

  if (pptLookupError) {
    console.error('documents:delete:artifact-lookup', pptLookupError)
    sendError(res, 500, 'Could not delete this document.')
    return
  }
  const generatedKeys = Array.from(
    new Set((pptRows ?? []).map((entry) => entry.storage_key as string).filter(Boolean)),
  )

  try {
    for (const key of generatedKeys) {
      await deleteObject(key)
    }
    if (row.storage_key) {
      await deleteObject(row.storage_key)
    }
  } catch (error) {
    // A real storage failure (not "already gone") — stop here rather than
    // deleting the row, so the document isn't left pointing at a file we
    // couldn't actually remove, and the user can safely retry.
    console.error('documents:delete:storage', error)
    sendError(res, 500, 'Could not delete the stored file. Please try again.')
    return
  }

  const { error: deleteError } = await client.from('documents').delete().eq('id', documentId).eq('user_id', user.id)
  if (deleteError) {
    console.error('documents:delete:row', deleteError)
    sendError(res, 500, 'The file was removed, but the document record could not be deleted. Please try again.')
    return
  }

  await emitEvent('document.deleted', { documentId })
  sendJson(res, 200, { success: true })
}

export default withErrorHandling(handler)
