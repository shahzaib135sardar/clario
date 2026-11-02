import { getExternalChatbotConfig } from './env'
import type { ChatTurn } from './anthropicClient'
import { UnsafeUrlError, assertSafeOutboundUrl } from './ssrf'
import { resilientFetch } from './resilience'

export class AiProviderError extends Error {}

/**
 * Forwards one chat turn to a chatbot you host yourself, instead of
 * Claude. Set CHAT_PROVIDER=external and EXTERNAL_CHATBOT_URL (and
 * EXTERNAL_CHATBOT_API_KEY, if yours needs one) to enable this path from
 * api/documents/[id]/chat.ts — see the README's "Connecting your own
 * chatbot" section for the full switch-over steps.
 *
 * The request/response shape below (POST { systemPrompt, message, history }
 * -> { reply }) is a default this file assumes, not a standard your service
 * has to already match. If your API expects something else, this is the
 * one place to change: adjust the `body` sent below and how `reply` is
 * read back out of the response.
 */
export async function completeExternalChat(
  systemPrompt: string,
  history: ChatTurn[],
  message: string,
): Promise<string> {
  const config = getExternalChatbotConfig()
  if (!config) {
    throw new AiProviderError('No external chatbot is configured (set EXTERNAL_CHATBOT_URL).')
  }

  // The URL is operator-supplied configuration, but it is still checked so a typo or a
  // compromised setting can't point the server at internal addresses (SSRF).
  let target: URL
  try {
    target = await assertSafeOutboundUrl(config.url, { allowHttp: process.env.NODE_ENV !== 'production', allowPrivate: process.env.NODE_ENV !== 'production', resolve: process.env.NODE_ENV === 'production' })
  } catch (error) {
    throw new AiProviderError(error instanceof UnsafeUrlError ? `EXTERNAL_CHATBOT_URL is not allowed: ${error.message}` : 'EXTERNAL_CHATBOT_URL is invalid.')
  }

  let response: Response
  try {
    response = await resilientFetch('external-chatbot', target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ systemPrompt, message, history }),
    }, { timeoutMs: 25_000, retries: 1 })
  } catch (error) {
    console.error('external-chatbot:network', error)
    throw new AiProviderError('Could not reach your chatbot service. Please try again.')
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error('external-chatbot:status', response.status, body)
    throw new AiProviderError('Your chatbot service could not process this request.')
  }

  const payload = (await response.json().catch(() => null)) as { reply?: unknown } | null
  if (!payload || typeof payload.reply !== 'string' || !payload.reply.trim()) {
    throw new AiProviderError('Your chatbot service returned an unexpected response shape.')
  }
  return payload.reply
}
