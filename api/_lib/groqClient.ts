import { getGroqConfig } from './env'
import type { ChatTurn } from './anthropicClient'
import { CircuitOpenError, TimeoutError, resilientFetch } from './resilience'

export class AiProviderError extends Error {}

const GROQ_CHAT_COMPLETIONS_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_MAX_OUTPUT_TOKENS = 2048

/**
 * Turns a failed Groq response into a message that says what to fix. Only the
 * kind of problem and the variable names are mentioned, never a key or any
 * raw provider text, so the message is safe to show in the app.
 */
export function describeGroqFailure(status: number, body: string): string {
  let code = ''
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } }
    code = `${String(parsed.error?.code ?? '')} ${String(parsed.error?.type ?? '')}`.toLowerCase()
  } catch {
    /* body was not JSON */
  }

  if (status === 401 || code.includes('invalid_api_key')) {
    return 'Groq rejected the API key. Check GROQ_API_KEY in .env (create a fresh key at console.groq.com), then restart the server.'
  }
  if (status === 404 || code.includes('model_not_found') || code.includes('model_decommissioned')) {
    return 'Your Groq account cannot use the configured model. Run "node scripts/check-ai.mjs" to list the models available to you, then set GROQ_MODEL in .env.'
  }
  if (status === 403) {
    return 'Groq refused this request. The key may be restricted, or the account may need to accept the model terms in the Groq console.'
  }
  if (status === 413 || code.includes('request_too_large')) {
    return 'The request is too large for the AI service. Try a shorter question or job description.'
  }
  if (status === 429) {
    return 'Groq is rate-limiting this key. Wait a minute and try again.'
  }
  return 'The AI service could not process this request.'
}

type GroqMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Plain fetch against Groq's OpenAI-compatible Chat Completions API, rather
 * than an SDK dependency, for one small call shape.
 */
async function groqComplete(messages: GroqMessage[], maxTokens: number): Promise<string> {
  const { apiKey, model } = getGroqConfig()

  let response: Response
  try {
    // Timeout, up to 2 retries with exponential backoff (429/5xx/network), and a circuit
    // breaker so a Groq outage fails fast instead of making every request wait.
    response = await resilientFetch(
      'groq',
      GROQ_CHAT_COMPLETIONS_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.3,
          messages,
        }),
      },
      { timeoutMs: 20_000, retries: 2, baseDelayMs: 500, maxDelayMs: 4_000 },
    )
  } catch (error) {
    console.error('groq:network', error instanceof Error ? error.name : error)
    if (error instanceof CircuitOpenError) {
      throw new AiProviderError('The AI service is having trouble right now. Please try again in a minute.')
    }
    if (error instanceof TimeoutError) {
      throw new AiProviderError('The AI service took too long to respond. Please try again.')
    }
    throw new AiProviderError('Could not reach Groq. Check the internet connection and try again.')
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error('groq:status', response.status, body)
    throw new AiProviderError(describeGroqFailure(response.status, body))
  }

  const payload = (await response.json().catch(() => null)) as
    | { choices?: { message?: { content?: string } }[] }
    | null
  const text = payload?.choices?.[0]?.message?.content
  if (!text || !text.trim()) {
    throw new AiProviderError('The AI service returned an empty response.')
  }
  return text
}

/** Single-shot structured generation. Always used by the resume analyzer; also used for every feature when AI_PROVIDER=groq. */
export async function completeGroqGeneration(
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens?: number } = {},
): Promise<string> {
  return groqComplete(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  )
}

/** Multi-turn grounded chat, used when AI_PROVIDER=groq. */
export async function completeGroqChat(systemPrompt: string, history: ChatTurn[]): Promise<string> {
  return groqComplete(
    [{ role: 'system', content: systemPrompt }, ...history.map((turn) => ({ role: turn.role, content: turn.content }))],
    1536,
  )
}
