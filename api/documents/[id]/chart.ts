import { isUuid } from '../../_lib/validation'
import { withErrorHandling, getPathSegments, requireMethod, sendError, sendJson, type ApiRequest, type ApiResponse } from '../../_lib/http'
import { requireAuth, requireRateLimit } from '../../_lib/guard'
import { beginIdempotent } from '../../_lib/idempotency'
import { emitEvent } from '../../_lib/events'
import { RATE_LIMITS } from '../../_lib/rateLimit'
import { loadReadyDocumentWithText, truncateForContext } from '../../_lib/documentContext'
import { completeGeneration } from '../../_lib/aiProvider'
import { extractJsonObject, AiResponseParseError } from '../../_lib/jsonExtraction'
import { validateChartContent, ArtifactShapeError, type ChartContent } from '../../_lib/artifactSchemas'

const SYSTEM_PROMPT = `You are Clario's chart-data engine. Find the single most meaningful \
quantitative breakdown in the document — a numeric comparison across categories, a mix, a \
distribution, or (if nothing numeric is present) a count of how often 3-6 key themes are \
discussed. Respond with JSON only, no prose before or after, matching exactly this shape:
{"title": string, "lede": string, "totalLabel": string, "totalValue": string, "sourceNote": string, "series": [{"label": string, "value": number}]}
Provide 3 to 6 series entries. "value" must be a plain non-negative number (not a string, no \
units or percent signs). "totalValue" is a short display string for the headline total (for \
example "$18.6m" or "42 mentions"), or an empty string if there is no single meaningful total. \
"sourceNote" briefly says where in the document this came from. Do not invent numbers that \
aren't supported by the document — if you must estimate, say so in "lede".`

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
      .eq('kind', 'chart')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error('chart:get', error)
      sendError(res, 500, 'Could not load the chart.')
      return
    }
    sendJson(res, 200, { chart: data ? { id: data.id, content: data.content, createdAt: data.created_at } : null })
    return
  }

  // POST — generate (or regenerate) the chart data.
  if (!(await requireRateLimit(res, RATE_LIMITS.chartGeneratePerUser, user.id))) return

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

  let content: ChartContent
  try {
    const raw = await completeGeneration(SYSTEM_PROMPT, userPrompt)
    content = validateChartContent(extractJsonObject(raw))
  } catch (error) {
    console.error('chart:generate', error)
    const message =
      error instanceof AiResponseParseError || error instanceof ArtifactShapeError
        ? 'A chart could not be generated in a usable format. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Could not generate a chart right now.'
    sendError(res, 502, message)
    return
  }

  const { data: inserted, error: insertError } = await client
    .from('generated_artifacts')
    .insert({ document_id: documentId, user_id: user.id, kind: 'chart', content })
    .select('id, content, created_at')
    .single()

  if (insertError || !inserted) {
    console.error('chart:insert', insertError)
    sendError(res, 500, 'The chart was generated but could not be saved.')
    return
  }

  await emitEvent('artifact.generated', { documentId, kind: 'chart' })
  sendJson(res, 200, { chart: { id: inserted.id, content: inserted.content, createdAt: inserted.created_at } })
}

export default withErrorHandling(handler)
