import { getAiProvider } from './env'
import {
  completeChat as completeAnthropicChat,
  completeGeneration as completeAnthropicGeneration,
  type ChatTurn,
} from './anthropicClient'
import { completeGroqChat, completeGroqGeneration } from './groqClient'
import { ConfigurationError } from './env'
import { CircuitOpenError, OverloadedError, TimeoutError } from './resilience'
import { incCounter } from './metrics'
import { logger } from './logger'

export type { ChatTurn }

const GENERATION_MAX_OUTPUT_TOKENS = 3072

type Provider = 'anthropic' | 'groq'

/**
 * Optional second provider used when the primary one is down or overloaded.
 * AI_FALLBACK_PROVIDER=anthropic|groq (must differ from AI_PROVIDER, and its own
 * keys must be set). Unset means no fallback.
 */
export function getFallbackProvider(env: NodeJS.ProcessEnv = process.env, primary: Provider = getAiProvider()): Provider | null {
  const value = env.AI_FALLBACK_PROVIDER?.trim().toLowerCase()
  if (value !== 'anthropic' && value !== 'groq') return null
  return value === primary ? null : value
}

/** Failing over helps for outages and throttling, never for bad configuration or bad input. */
export function isFailoverWorthy(error: unknown): boolean {
  if (error instanceof ConfigurationError) return false
  if (error instanceof CircuitOpenError || error instanceof TimeoutError || error instanceof OverloadedError) return true
  // Each provider module has its own AiProviderError class; match by name. A prompt that is
  // too large for one provider is not fixed by asking another.
  if (error instanceof Error && error.constructor.name === 'AiProviderError') return !/too large/i.test(error.message)
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') return status === 429 || status >= 500
  return error instanceof Error // network-level failures from an SDK
}

export async function withFailover<T>(
  run: (provider: Provider) => Promise<T>,
  options: { primary?: Provider; fallback?: Provider | null } = {},
): Promise<T> {
  const primary = options.primary ?? getAiProvider()
  const fallback = options.fallback === undefined ? getFallbackProvider() : options.fallback
  try {
    return await run(primary)
  } catch (error) {
    if (!fallback || !isFailoverWorthy(error)) throw error
    logger.warn('ai provider failover', { from: primary, to: fallback, reason: error instanceof Error ? error.name : 'error' })
    incCounter('ai_failover_total', { from: primary, to: fallback })
    return run(fallback)
  }
}

/**
 * The one place that decides which model answers. AI_PROVIDER=anthropic (the
 * default) uses Claude; AI_PROVIDER=groq sends everything to Groq instead, so
 * the app can run on Groq's free tier until Anthropic credit is added. The
 * resume analyzer and job suggestions always use Groq regardless of this setting.
 */
export function completeChat(systemPrompt: string, history: ChatTurn[]): Promise<string> {
  return withFailover((provider) =>
    provider === 'groq' ? completeGroqChat(systemPrompt, history) : completeAnthropicChat(systemPrompt, history),
  )
}

export function completeGeneration(systemPrompt: string, userPrompt: string): Promise<string> {
  return withFailover((provider) =>
    provider === 'groq'
      ? completeGroqGeneration(systemPrompt, userPrompt, { maxTokens: GENERATION_MAX_OUTPUT_TOKENS })
      : completeAnthropicGeneration(systemPrompt, userPrompt),
  )
}
