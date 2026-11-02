import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicConfig } from './env'

let cachedClient: Anthropic | null = null

function getClient(): Anthropic {
  if (cachedClient) return cachedClient
  const { apiKey } = getAnthropicConfig()
  cachedClient = new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 })
  return cachedClient
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

export class AiProviderError extends Error {}

const CHAT_MAX_OUTPUT_TOKENS = 1536
const GENERATION_MAX_OUTPUT_TOKENS = 3072

/**
 * Turns an Anthropic failure into a message that says what to fix. Only the
 * kind of problem and the variable names are mentioned, never a key or other
 * value, so the text is safe to show in the app.
 */
export function describeProviderFailure(error: unknown, fallback: string): string {
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach Anthropic. Check the internet connection and try again.'
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status
    const detail = String(error.message ?? '').toLowerCase()
    if (status === 401) {
      return 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env, then restart the server.'
    }
    if (status === 403) {
      return 'This Anthropic key is not allowed to use that model. Check the key and the model IDs in .env.'
    }
    if (status === 404) {
      return 'Anthropic does not recognise the configured model ID. Check ANTHROPIC_MODEL_CHAT and ANTHROPIC_MODEL_GENERATION in .env (for example claude-haiku-5-5 and claude-sonnet-5-5).'
    }
    if (status === 400 && detail.includes('credit balance')) {
      return 'The Anthropic account has no credit left. Add credit in the Anthropic Console under Billing.'
    }
    if (status === 429) {
      return 'Anthropic is rate-limiting this key. Wait a moment and try again.'
    }
  }
  return fallback
}

function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  )
  if (!textBlock || !textBlock.text.trim()) {
    throw new AiProviderError('The assistant returned an empty response.')
  }
  return textBlock.text
}

/** A grounded, multi-turn chat reply — used by the document chat route. */
export async function completeChat(systemPrompt: string, history: ChatTurn[]): Promise<string> {
  const { chatModel } = getAnthropicConfig()
  try {
    const response = await getClient().messages.create({
      model: chatModel,
      max_tokens: CHAT_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
    })
    return extractText(response)
  } catch (error) {
    if (error instanceof AiProviderError) throw error
    console.error('anthropic:chat', error)
    throw new AiProviderError(
      describeProviderFailure(error, 'The assistant could not generate a reply. Please try again.'),
    )
  }
}

/** A single-shot structured-generation call (summary/chart/plan/PPTX outline). */
export async function completeGeneration(systemPrompt: string, userPrompt: string): Promise<string> {
  const { generationModel } = getAnthropicConfig()
  try {
    const response = await getClient().messages.create({
      model: generationModel,
      max_tokens: GENERATION_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })
    return extractText(response)
  } catch (error) {
    if (error instanceof AiProviderError) throw error
    console.error('anthropic:generation', error)
    throw new AiProviderError(
      describeProviderFailure(error, 'Could not generate this right now. Please try again.'),
    )
  }
}
