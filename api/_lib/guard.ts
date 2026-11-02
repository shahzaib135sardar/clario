import { getBearerToken, sendError, type ApiRequest, type ApiResponse } from './http'
import { checkRateLimit } from './rateLimit'
import { authenticate, type AuthedRequest } from './supabaseServer'
import { setContextValue } from './logger'

export async function requireAuth(req: ApiRequest, res: ApiResponse): Promise<AuthedRequest | null> {
  const token = getBearerToken(req)
  if (!token) {
    sendError(res, 401, 'Sign in to continue.')
    return null
  }
  const authed = await authenticate(token)
  if (!authed) {
    sendError(res, 401, 'Your session has expired. Please sign in again.')
    return null
  }
  setContextValue('userId', authed.user.id)
  return authed
}

export async function requireRateLimit(
  res: ApiResponse,
  budget: { name: string; limit: number; windowSeconds: number },
  identifier: string,
): Promise<boolean> {
  const result = await checkRateLimit(budget.name, identifier, budget.limit, budget.windowSeconds)
  if (!result.success) {
    const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
    res.setHeader('Retry-After', String(retryAfterSeconds))
    sendError(res, 429, 'Too many requests. Please slow down and try again shortly.')
    return false
  }
  return true
}
