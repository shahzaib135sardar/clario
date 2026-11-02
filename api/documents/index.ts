import { randomUUID } from 'node:crypto'
import {
  withErrorHandling,
  BadRequestError,
  getClientIp,
  readJsonBody,
  requireMethod,
  sendError,
  sendJson,
  type ApiRequest,
  type ApiResponse,
} from '../_lib/http'
import { requireAuth, requireRateLimit } from '../_lib/guard'
import { beginIdempotent } from '../_lib/idempotency'
import { emitEvent } from '../_lib/events'
import { runSaga } from '../_lib/saga'
import { RATE_LIMITS } from '../_lib/rateLimit'
import { createSignedUploadUrl } from '../_lib/r2'
import {
  FILE_NAME_MAX_LENGTH,
  MAX_EXTRACTED_CHARACTERS,
  MAX_FILE_BYTES,
  isNonEmptyString,
  isWithinSizeLimit,
  kindForMimeType,
  sanitizeFileNameForKey,
} from '../_lib/validation'
import { DOCUMENT_SELECT_COLUMNS, toDocumentSummary, type DocumentRow } from '../_lib/documents'

async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (!requireMethod(req, res, ['GET', 'POST'])) return

  const authed = await requireAuth(req, res)
  if (!authed) return
  const { client, user } = authed
  if (req.method === 'POST' && !(await beginIdempotent(req, res, user.id))) return

  if (req.method === 'GET') {
    if (!(await requireRateLimit(res, RATE_LIMITS.documentListPerUser, user.id))) return

    const { data, error } = await client
      .from('documents')
      .select(DOCUMENT_SELECT_COLUMNS)
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      console.error('documents:list', error)
      sendError(res, 500, 'Could not load your documents.')
      return
    }

    sendJson(res, 200, { documents: (data as DocumentRow[]).map(toDocumentSummary) })
    return
  }

  // POST — create a pending document row and hand back a short-lived,
  // signed R2 upload URL. The file itself is never sent to this function.
  if (!(await requireRateLimit(res, RATE_LIMITS.documentCreatePerUser, user.id))) return
  if (!(await requireRateLimit(res, RATE_LIMITS.documentCreatePerIp, getClientIp(req)))) return

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendError(res, 400, error instanceof BadRequestError ? error.message : 'Invalid request body.')
    return
  }

  const input = body as Record<string, unknown>
  const { fileName, fileType, fileSize, extractedText } = input

  if (!isNonEmptyString(fileName, FILE_NAME_MAX_LENGTH)) {
    sendError(res, 400, 'A valid file name is required.')
    return
  }
  if (typeof fileType !== 'string' || !kindForMimeType(fileType)) {
    sendError(res, 400, 'Only PDF and Word (.docx) files are supported.')
    return
  }
  if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || !isWithinSizeLimit(fileSize)) {
    sendError(res, 400, `File size must be between 1 byte and ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`)
    return
  }
  if (!isNonEmptyString(extractedText, MAX_EXTRACTED_CHARACTERS)) {
    sendError(res, 400, 'No extracted text was provided for this document.')
    return
  }

  const documentId = randomUUID()
  const storageKey = `${user.id}/${documentId}/${sanitizeFileNameForKey(fileName)}`

  // Two steps that each need undoing if a later one fails (a saga): the row is removed
  // again if no upload URL can be produced, so no pending row is left with no way to finish.
  let uploadUrl = ''
  try {
    await runSaga(
      [
        {
          name: 'create-document-row',
          run: async () => {
            const { error: insertError } = await client.from('documents').insert({
              id: documentId,
              user_id: user.id,
              file_name: fileName,
              file_type: fileType,
              file_size: fileSize,
              extracted_text: extractedText,
              storage_key: storageKey,
              status: 'pending',
            })
            if (insertError) throw insertError
          },
          compensate: async () => {
            await client.from('documents').delete().eq('id', documentId).eq('user_id', user.id)
          },
        },
        {
          name: 'sign-upload-url',
          run: async () => {
            uploadUrl = await createSignedUploadUrl(storageKey, fileType, fileSize)
          },
        },
      ],
      {},
    )
  } catch (error) {
    const failedStep = error instanceof Error && 'failedStep' in error ? String((error as { failedStep: unknown }).failedStep) : 'unknown'
    console.error('documents:create', failedStep, error instanceof Error && 'cause' in error ? (error as { cause: unknown }).cause : error)
    sendError(
      res,
      500,
      failedStep === 'sign-upload-url' ? 'Could not prepare the upload. Please try again.' : 'Could not start this upload. Please try again.',
    )
    return
  }

  await emitEvent('document.created', { documentId, fileType })
  sendJson(res, 201, { documentId, uploadUrl, storageKey })
}

export default withErrorHandling(handler)
