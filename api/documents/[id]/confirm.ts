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
import { beginIdempotent } from '../../_lib/idempotency'
import { RATE_LIMITS } from '../../_lib/rateLimit'
import { deleteObject, headObject, readObjectPrefix } from '../../_lib/r2'
import { kindForMimeType, MAX_FILE_BYTES, isUuid } from '../../_lib/validation'
import { SIGNATURE_PREFIX_BYTES, sniffFileKind } from '../../../shared/fileRules'
import { DOCUMENT_SELECT_COLUMNS, toDocumentSummary, type DocumentRow } from '../../_lib/documents'

function getDocumentId(req: ApiRequest): string | null {
  const segments = getPathSegments(req)
  const index = segments.indexOf('documents')
  const id = index >= 0 ? segments[index + 1] : undefined
  return id ?? null
}

async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (!requireMethod(req, res, ['POST'])) return

  const documentId = getDocumentId(req)
  if (!documentId || !isUuid(documentId)) {
    sendError(res, 400, 'Invalid document id.')
    return
  }

  const authed = await requireAuth(req, res)
  if (!authed) return
  const { client, user } = authed
  if (req.method === 'POST' && !(await beginIdempotent(req, res, user.id))) return

  if (!(await requireRateLimit(res, RATE_LIMITS.documentConfirmPerUser, user.id))) return

  const { data, error } = await client
    .from('documents')
    .select(DOCUMENT_SELECT_COLUMNS)
    .eq('id', documentId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    console.error('documents:confirm:lookup', error)
    sendError(res, 500, 'Could not confirm this upload.')
    return
  }
  if (!data) {
    sendError(res, 404, 'Document not found.')
    return
  }

  const row = data as DocumentRow

  // Already confirmed — treat as a successful no-op rather than erroring,
  // since a flaky network can legitimately cause a client to retry this call.
  if (row.status === 'ready') {
    sendJson(res, 200, { document: toDocumentSummary(row) })
    return
  }

  if (!row.storage_key) {
    sendError(res, 400, 'This document has no associated upload to confirm.')
    return
  }

  const markFailed = async (message: string) => {
    await client.from('documents').update({ status: 'failed' }).eq('id', documentId).eq('user_id', user.id)
    sendError(res, 400, message)
  }

  // The client's own checks are a convenience, not a boundary — re-verify
  // the object that actually landed in R2 before trusting any of it.
  const head = await headObject(row.storage_key)
  if (!head) {
    await markFailed('The upload did not complete. Please try again.')
    return
  }
  if (head.size !== row.file_size || head.size > MAX_FILE_BYTES) {
    await deleteObject(row.storage_key)
    await markFailed('The uploaded file size did not match what was expected. Please try again.')
    return
  }

  const expectedKind = kindForMimeType(row.file_type)
  const prefix = await readObjectPrefix(row.storage_key, SIGNATURE_PREFIX_BYTES)
  const actualKind = prefix ? sniffFileKind(prefix) : null
  if (!expectedKind || !actualKind || actualKind !== expectedKind) {
    await deleteObject(row.storage_key)
    await markFailed('The uploaded file does not match the expected file type.')
    return
  }

  const { data: updated, error: updateError } = await client
    .from('documents')
    .update({ status: 'ready' })
    .eq('id', documentId)
    .eq('user_id', user.id)
    .select(DOCUMENT_SELECT_COLUMNS)
    .maybeSingle()

  if (updateError || !updated) {
    console.error('documents:confirm:update', updateError)
    sendError(res, 500, 'Could not finish confirming this upload.')
    return
  }

  sendJson(res, 200, { document: toDocumentSummary(updated as DocumentRow) })
}

export default withErrorHandling(handler)
