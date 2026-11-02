import {
  withErrorHandling,
  getPathSegments,
  readJsonBody,
  requireMethod,
  sendError,
  sendJson,
  BadRequestError,
  type ApiRequest,
  type ApiResponse,
} from '../../_lib/http'
import { requireAuth, requireRateLimit } from '../../_lib/guard'
import { beginIdempotent } from '../../_lib/idempotency'
import { emitEvent } from '../../_lib/events'
import { RATE_LIMITS } from '../../_lib/rateLimit'
import { isNonEmptyString, isUuid } from '../../_lib/validation'
import { loadReadyDocumentWithText, truncateForContext } from '../../_lib/documentContext'
import { completeGroqGeneration } from '../../_lib/groqClient'
import { extractJsonObject, AiResponseParseError } from '../../_lib/jsonExtraction'
import { validateResumeAnalysisContent, ArtifactShapeError, type ResumeAnalysisContent } from '../../_lib/artifactSchemas'

const JOB_DESCRIPTION_MAX_LENGTH = 6000

const SYSTEM_PROMPT = `You are Clario's resume-fit analyzer. Compare the candidate's resume \
against the target job description and assess the match honestly — do not inflate the score to \
be encouraging. Respond with JSON only, no prose before or after, matching exactly this shape:
{"matchScore": number, "summary": string, "strengths": [string], "gaps": [string], "missingKeywords": [string], "suggestions": [string]}
"matchScore" is 0-100. "summary" is one short paragraph. "strengths" and "gaps" are each 2 to 5 \
short bullet points grounded in the resume's actual content. "missingKeywords" lists specific \
skills, tools, or qualifications the job description asks for that the resume does not \
mention. "suggestions" are 2 to 5 concrete, actionable edits the candidate could make to the \
resume itself.`

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
      .eq('kind', 'resume_analysis')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error('resume-analysis:get', error)
      sendError(res, 500, 'Could not load the resume analysis.')
      return
    }
    sendJson(res, 200, { analysis: data ? { id: data.id, content: data.content, createdAt: data.created_at } : null })
    return
  }

  // POST — analyze the resume against a job description.
  if (!(await requireRateLimit(res, RATE_LIMITS.resumeAnalyzePerUser, user.id))) return

  const doc = await loadReadyDocumentWithText(client, res, user.id, documentId)
  if (!doc) return

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendError(res, 400, error instanceof BadRequestError ? error.message : 'Invalid request body.')
    return
  }

  const { jobDescription } = body as Record<string, unknown>
  if (!isNonEmptyString(jobDescription, JOB_DESCRIPTION_MAX_LENGTH)) {
    sendError(res, 400, `Paste a job description up to ${JOB_DESCRIPTION_MAX_LENGTH} characters.`)
    return
  }
  const trimmedJobDescription = jobDescription.trim()

  const { text: resumeText, truncated } = truncateForContext(doc.extracted_text)
  const userPrompt = [
    `Resume (${doc.file_name}):`,
    truncated ? '(Only the first portion of this long resume is shown below.)' : '',
    '---',
    resumeText,
    '---',
    '',
    'Target job description:',
    '---',
    trimmedJobDescription,
    '---',
  ].join('\n')

  let content: ResumeAnalysisContent
  try {
    const raw = await completeGroqGeneration(SYSTEM_PROMPT, userPrompt)
    content = validateResumeAnalysisContent(extractJsonObject(raw))
  } catch (error) {
    console.error('resume-analysis:generate', error)
    const message =
      error instanceof AiResponseParseError || error instanceof ArtifactShapeError
        ? 'The analysis could not be generated in a usable format. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Could not analyze this resume right now.'
    sendError(res, 502, message)
    return
  }

  const fullContent = { jobDescription: trimmedJobDescription, ...content }
  const { data: inserted, error: insertError } = await client
    .from('generated_artifacts')
    .insert({ document_id: documentId, user_id: user.id, kind: 'resume_analysis', content: fullContent })
    .select('id, content, created_at')
    .single()

  if (insertError || !inserted) {
    console.error('resume-analysis:insert', insertError)
    sendError(res, 500, 'The analysis was generated but could not be saved.')
    return
  }

  await emitEvent('resume.analyzed', { documentId })
  sendJson(res, 200, { analysis: { id: inserted.id, content: inserted.content, createdAt: inserted.created_at } })
}

export default withErrorHandling(handler)
