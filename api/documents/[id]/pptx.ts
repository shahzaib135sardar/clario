import { isUuid } from '../../_lib/validation'
import PptxGenJS from 'pptxgenjs'
import { withErrorHandling, getPathSegments, requireMethod, sendError, sendJson, type ApiRequest, type ApiResponse } from '../../_lib/http'
import { requireAuth, requireRateLimit } from '../../_lib/guard'
import { beginIdempotent } from '../../_lib/idempotency'
import { emitEvent } from '../../_lib/events'
import { RATE_LIMITS } from '../../_lib/rateLimit'
import { loadReadyDocumentWithText, truncateForContext } from '../../_lib/documentContext'
import { completeGeneration } from '../../_lib/aiProvider'
import { extractJsonObject, AiResponseParseError } from '../../_lib/jsonExtraction'
import { validateSlideOutline, ArtifactShapeError, type SlideOutline } from '../../_lib/artifactSchemas'
import { putObject, createSignedDownloadUrl } from '../../_lib/r2'

const SYSTEM_PROMPT = `You are Clario's presentation-outline engine. Turn the document into a \
concise briefing deck. Respond with JSON only, no prose before or after, matching exactly this \
shape:
{"deckTitle": string, "deckSubtitle": string, "slides": [{"kicker": string, "title": string, "bullets": [string], "notes": string}]}
Produce 6 to 9 slides including a natural opening and closing slide. Each slide's "kicker" is a \
short all-caps-style label (for example "OVERVIEW" or "KEY FINDINGS"), "title" is a short \
headline (not a full sentence), "bullets" is 2 to 4 short supporting points, and "notes" is one \
or two sentences of speaker notes. Ground everything in the document's actual content.`

const PPTX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

// Monochrome palette matching the app's own visual direction.
const INK = '171816'
const MUTED = '7B7D78'
const LINE = 'E8E9E5'
const PAPER = 'FFFFFF'

function storageKeyFor(userId: string, documentId: string): string {
  return `${userId}/${documentId}/presentation.pptx`
}

function downloadFileNameFor(docFileName: string): string {
  const base = docFileName.replace(/\.[^.]+$/, '').trim() || 'document'
  return `${base} - Presentation.pptx`
}

async function renderDeck(outline: SlideOutline): Promise<Uint8Array> {
  const pres = new PptxGenJS()
  pres.defineLayout({ name: 'CLARIO_16X9', width: 10, height: 5.63 })
  pres.layout = 'CLARIO_16X9'

  const title = pres.addSlide()
  title.background = { color: INK }
  title.addText(outline.deckTitle, {
    x: 0.6, y: 2.0, w: 8.8, h: 1.4,
    fontFace: 'Georgia', fontSize: 36, color: PAPER, bold: false,
  })
  if (outline.deckSubtitle) {
    title.addText(outline.deckSubtitle, {
      x: 0.6, y: 3.3, w: 8.8, h: 0.6,
      fontFace: 'Arial', fontSize: 14, color: 'C9CAC5',
    })
  }
  title.addText('CLARIO', {
    x: 0.6, y: 0.5, w: 4, h: 0.4,
    fontFace: 'Arial', fontSize: 11, color: '9A9B96', charSpacing: 2,
  })

  for (const slide of outline.slides) {
    const s = pres.addSlide()
    s.background = { color: PAPER }
    if (slide.kicker) {
      s.addText(slide.kicker.toUpperCase(), {
        x: 0.6, y: 0.45, w: 8.8, h: 0.35,
        fontFace: 'Arial', fontSize: 10, color: MUTED, bold: true, charSpacing: 1.2,
      })
    }
    s.addText(slide.title, {
      x: 0.6, y: 0.82, w: 8.8, h: 0.9,
      fontFace: 'Georgia', fontSize: 26, color: INK,
    })
    s.addShape('line', { x: 0.6, y: 1.72, w: 0.6, h: 0, line: { color: INK, width: 2 } })

    if (slide.bullets.length > 0) {
      s.addText(
        slide.bullets.map((bullet) => ({ text: bullet, options: { bullet: { code: '2022' }, breakLine: true } })),
        {
          x: 0.6, y: 2.05, w: 8.8, h: 3.0,
          fontFace: 'Arial', fontSize: 14, color: '3D3F3A', lineSpacingMultiple: 1.35,
        },
      )
    }
    s.addShape('line', { x: 0, y: 5.5, w: 10, h: 0, line: { color: LINE, width: 1 } })

    if (slide.notes) s.addNotes(slide.notes)
  }

  const buffer = await pres.write({ outputType: 'nodebuffer' })
  return buffer as Uint8Array
}

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
    if (!(await requireRateLimit(res, RATE_LIMITS.pptxDownloadPerUser, user.id))) return
    const doc = await loadReadyDocumentWithText(client, res, user.id, documentId)
    if (!doc) return

    const { data, error } = await client
      .from('generated_artifacts')
      .select('id, content, storage_key, created_at')
      .eq('document_id', documentId)
      .eq('kind', 'ppt')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error('pptx:get', error)
      sendError(res, 500, 'Could not load the presentation.')
      return
    }
    if (!data?.storage_key) {
      sendJson(res, 200, { presentation: null })
      return
    }

    const downloadUrl = await createSignedDownloadUrl(data.storage_key, downloadFileNameFor(doc.file_name))
    sendJson(res, 200, {
      presentation: { id: data.id, content: data.content, createdAt: data.created_at, downloadUrl },
    })
    return
  }

  // POST — generate (or regenerate) the deck.
  if (!(await requireRateLimit(res, RATE_LIMITS.pptxGeneratePerUser, user.id))) return

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

  let outline: SlideOutline
  try {
    const raw = await completeGeneration(SYSTEM_PROMPT, userPrompt)
    outline = validateSlideOutline(extractJsonObject(raw))
  } catch (error) {
    console.error('pptx:outline', error)
    const message =
      error instanceof AiResponseParseError || error instanceof ArtifactShapeError
        ? 'The presentation outline could not be generated in a usable format. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Could not generate a presentation right now.'
    sendError(res, 502, message)
    return
  }

  let deckBuffer: Uint8Array
  try {
    deckBuffer = await renderDeck(outline)
  } catch (error) {
    console.error('pptx:render', error)
    sendError(res, 500, 'The presentation outline was generated, but the file could not be built.')
    return
  }

  const storageKey = storageKeyFor(user.id, documentId)
  try {
    await putObject(storageKey, deckBuffer, PPTX_CONTENT_TYPE)
  } catch (error) {
    console.error('pptx:upload', error)
    sendError(res, 500, 'Could not save the generated presentation.')
    return
  }

  const content = { deckTitle: outline.deckTitle, deckSubtitle: outline.deckSubtitle, slideCount: outline.slides.length }
  const { data: inserted, error: insertError } = await client
    .from('generated_artifacts')
    .insert({ document_id: documentId, user_id: user.id, kind: 'ppt', content, storage_key: storageKey })
    .select('id, content, created_at')
    .single()

  if (insertError || !inserted) {
    console.error('pptx:insert', insertError)
    sendError(res, 500, 'The presentation was generated but could not be recorded.')
    return
  }

  const downloadUrl = await createSignedDownloadUrl(storageKey, downloadFileNameFor(doc.file_name))
  await emitEvent('artifact.generated', { documentId, kind: 'ppt' })
  sendJson(res, 200, {
    presentation: { id: inserted.id, content: inserted.content, createdAt: inserted.created_at, downloadUrl },
  })
}

export default withErrorHandling(handler)
