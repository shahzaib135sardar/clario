import { withErrorHandling, requireMethod, sendError, sendJson, type ApiRequest, type ApiResponse } from './_lib/http'
import { requireAuth, requireRateLimit } from './_lib/guard'
import { RATE_LIMITS } from './_lib/rateLimit'

/**
 * Lightweight counts for the dashboard and settings pages — real numbers
 * instead of placeholder figures, scoped to the caller by RLS the same way
 * every other route is.
 */
async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (!requireMethod(req, res, ['GET'])) return

  const authed = await requireAuth(req, res)
  if (!authed) return
  const { client, user } = authed

  if (!(await requireRateLimit(res, RATE_LIMITS.usageGetPerUser, user.id))) return

  const [documentsResult, messagesResult, artifactsResult] = await Promise.all([
    client.from('documents').select('id', { count: 'exact', head: true }).eq('status', 'ready'),
    client.from('chat_messages').select('id', { count: 'exact', head: true }).eq('role', 'user'),
    client.from('generated_artifacts').select('id', { count: 'exact', head: true }),
  ])

  if (documentsResult.error || messagesResult.error || artifactsResult.error) {
    console.error('usage', documentsResult.error, messagesResult.error, artifactsResult.error)
    sendError(res, 500, 'Could not load usage.')
    return
  }

  sendJson(res, 200, {
    documents: documentsResult.count ?? 0,
    conversations: messagesResult.count ?? 0,
    artifacts: artifactsResult.count ?? 0,
  })
}

export default withErrorHandling(handler)
