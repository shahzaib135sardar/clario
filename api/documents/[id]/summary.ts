import { isUuid } from '../../_lib/validation'
import { withErrorHandling, getPathSegments, requireMethod, sendError, sendJson, type ApiRequest, type ApiResponse } from '../../_lib/http'
import { requireAuth, requireRateLimit } from '../../_lib/guard'
import { beginIdempotent } from '../../_lib/idempotency'
import { emitEvent } from '../../_lib/events'
import { RATE_LIMITS } from '../../_lib/rateLimit'
import { loadReadyDocumentWithText, truncateForContext } from '../../_lib/documentContext'
import { completeGeneration } from '../../_lib/aiProvider'
import { extractJsonObject, AiResponseParseError } from '../../_lib/jsonExtraction'
import { validateSummaryContent, ArtifactShapeError, type SummaryContent } from '../../_lib/artifactSchemas'

const SYSTEM_PROMPT = `You are Clario's summarization engine. Read the document and produce an \
executive summary grounded only in its content. Respond with JSON only, no prose before or \
after, matching exactly this shape:
{"headline": string, "lede": string, "points": [{"title": string, "body": string}]}
Provide 3 to 5 points. "headline" is a single sentence capturing the document's core takeaway. \
"lede" is one short paragraph of context. Each point's "title" is a few words; "body" is one \
or two sentences. Do not invent facts not supported by the document.`

function getDocumentId(req: ApiRequest): string | null {
  const segments = getPathSegments(req)
  const index = segments.indexOf('documents')
  const id = index >= 0 ? segments[index + 1] : undefined
  return id ?? null
}

async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (!requireMethod(req, res, ['GET', 'POST'])) return

  const documentId = getDocumentId(req)
  if (!documentId || !isUuid(documentId)) {
    sendError(res, 400, 'Invalid document id.')
    return
  }

  const authed = await requireAuth(req, res)
  if (!authed) return
  const { client, user } = authed
  if (req.method === 'POST' && !(await beginIdempotent(req, res, user.id))) return

  if (req.method === 'GET') {
    if (!(await requireRateLimit(res, RATE_LIMITS.artifactGetPerUser, user.id))) return
    const doc = await loadReadyDocumentWithText(client, res, user.id, documentId)
    if (!doc) return

    const { data, error } = await client
      .from('generated_artifacts')
      .select('id, content, created_at')
      .eq('document_id', documentId)
      .eq('kind', 'summary')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error('summary:get', error)
      sendError(res, 500, 'Could not load the summary.')
      return
    }
    sendJson(res, 200, { summary: data ? { id: data.id, content: data.content, createdAt: data.created_at } : null })
    return
  }

  // POST — generate (or regenerate) the summary.
  if (!(await requireRateLimit(res, RATE_LIMITS.summaryGeneratePerUser, user.id))) return

  const doc = await loadReadyDocumentWithText(client, res, user.id, documentId)
  if (!doc) return

  const { text: documentText, truncated } = truncateForContext(doc.extracted_text)
  const userPrompt = [
    `Document: ${doc.file_name}`,
    truncated ? '(Only the first portion of this long document is shown below.)' : '',
    '---',
    documentText,
    '---',
  ].join('\n')

  let content: SummaryContent
  try {
    const raw = await completeGeneration(SYSTEM_PROMPT, userPrompt)
    content = validateSummaryContent(extractJsonObject(raw))
  } catch (error) {
    console.error('summary:generate', error)
    const message =
      error instanceof AiResponseParseError || error instanceof ArtifactShapeError
        ? 'The summary could not be generated in a usable format. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Could not generate a summary right now.'
    sendError(res, 502, message)
    return
  }

  const { data: inserted, error: insertError } = await client
    .from('generated_artifacts')
    .insert({ document_id: documentId, user_id: user.id, kind: 'summary', content })
    .select('id, content, created_at')
    .single()

  if (insertError || !inserted) {
    console.error('summary:insert', insertError)
    sendError(res, 500, 'The summary was generated but could not be saved.')
    return
  }

  await emitEvent('artifact.generated', { documentId, kind: 'summary' })
  sendJson(res, 200, { summary: { id: inserted.id, content: inserted.content, createdAt: inserted.created_at } })
}

export default withErrorHandling(handler)
