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
import { RATE_LIMITS } from '../../_lib/rateLimit'
import { isNonEmptyString, isUuid } from '../../_lib/validation'
import { loadReadyDocumentWithText, truncateForContext } from '../../_lib/documentContext'
import { completeChat, type ChatTurn } from '../../_lib/aiProvider'
import { completeExternalChat } from '../../_lib/externalChatbot'
import { getChatProvider } from '../../_lib/env'

const MESSAGE_MAX_LENGTH = 4000
const HISTORY_TURN_LIMIT = 20 // most recent turns included as prompt context

type ChatMessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

function getDocumentId(req: ApiRequest): string | null {
  const segments = getPathSegments(req)
  const index = segments.indexOf('documents')
  const id = index >= 0 ? segments[index + 1] : undefined
  return id ?? null
}

function buildSystemPrompt(fileName: string, documentText: string, truncated: boolean): string {
  return [
    'You are Clario, a document-intelligence assistant. Answer the user strictly ',
    'using the document provided below. If the answer is not in the document, say ',
    "so plainly rather than guessing. Be concise and cite the relevant part of the ",
    'document in your own words when it helps.',
    '',
    `Document: ${fileName}`,
    truncated ? '(Note: this document is long — only its first portion is shown below.)' : '',
    '---',
    documentText,
    '---',
  ].join('\n')
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
    if (!(await requireRateLimit(res, RATE_LIMITS.chatListPerUser, user.id))) return

    const doc = await loadReadyDocumentWithText(client, res, user.id, documentId)
    if (!doc) return

    const { data, error } = await client
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('document_id', documentId)
      .order('created_at', { ascending: true })
      .limit(500)

    if (error) {
      console.error('chat:list', error)
      sendError(res, 500, 'Could not load this conversation.')
      return
    }

    sendJson(res, 200, { messages: data as ChatMessageRow[] })
    return
  }

  // POST — send a message and get a grounded reply.
  if (!(await requireRateLimit(res, RATE_LIMITS.chatSendPerUser, user.id))) return

  const doc = await loadReadyDocumentWithText(client, res, user.id, documentId)
  if (!doc) return

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendError(res, 400, error instanceof BadRequestError ? error.message : 'Invalid request body.')
    return
  }

  const { message } = body as Record<string, unknown>
  if (!isNonEmptyString(message, MESSAGE_MAX_LENGTH)) {
    sendError(res, 400, `Enter a message up to ${MESSAGE_MAX_LENGTH} characters.`)
    return
  }
  const userMessage = message.trim()

  const { data: priorRows, error: historyError } = await client
    .from('chat_messages')
    .select('id, role, content, created_at')
    .eq('document_id', documentId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_TURN_LIMIT)

  if (historyError) {
    console.error('chat:history', historyError)
    sendError(res, 500, 'Could not load this conversation.')
    return
  }
  const priorHistory = (priorRows as ChatMessageRow[]).reverse()

  const { data: insertedUserRow, error: insertUserError } = await client
    .from('chat_messages')
    .insert({ document_id: documentId, user_id: user.id, role: 'user', content: userMessage })
    .select('id, role, content, created_at')
    .single()

  if (insertUserError || !insertedUserRow) {
    console.error('chat:insert-user', insertUserError)
    sendError(res, 500, 'Could not send this message.')
    return
  }

  const { text: documentText, truncated } = truncateForContext(doc.extracted_text)
  const systemPrompt = buildSystemPrompt(doc.file_name, documentText, truncated)
  const history: ChatTurn[] = [
    ...priorHistory.map((row) => ({ role: row.role, content: row.content })),
    { role: 'user' as const, content: userMessage },
  ]

  let reply: string
  try {
    reply =
      getChatProvider() === 'external'
        ? await completeExternalChat(systemPrompt, history.slice(0, -1), userMessage)
        : await completeChat(systemPrompt, history)
  } catch (error) {
    console.error('chat:provider', error)
    // The user's message is already saved — only the reply failed — so the
    // conversation isn't lost and they can simply try again.
    sendJson(res, 200, {
      userMessage: insertedUserRow as ChatMessageRow,
      assistantMessage: null,
      error: error instanceof Error ? error.message : 'The assistant could not reply. Please try again.',
    })
    return
  }

  const { data: insertedAssistantRow, error: insertAssistantError } = await client
    .from('chat_messages')
    .insert({ document_id: documentId, user_id: user.id, role: 'assistant', content: reply })
    .select('id, role, content, created_at')
    .single()

  if (insertAssistantError || !insertedAssistantRow) {
    console.error('chat:insert-assistant', insertAssistantError)
    sendJson(res, 200, {
      userMessage: insertedUserRow as ChatMessageRow,
      assistantMessage: null,
      error: 'The assistant replied, but the reply could not be saved.',
    })
    return
  }

  sendJson(res, 200, {
    userMessage: insertedUserRow as ChatMessageRow,
    assistantMessage: insertedAssistantRow as ChatMessageRow,
  })
}

export default withErrorHandling(handler)
