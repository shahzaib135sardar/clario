// Reads server-only configuration. Every value here must come from a
// plain environment variable — never one prefixed VITE_, which would ship
// to the browser.

export class ConfigurationError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new ConfigurationError(`Server is missing the ${name} environment variable.`)
  }
  return value
}

export function getSupabaseConfig() {
  const url = requireEnv('SUPABASE_URL')
  let valid = false
  try {
    const parsed = new URL(url)
    valid = parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    valid = false
  }
  if (!valid) {
    // Names the variable only — never echo its value, it may be a secret pasted into the wrong line.
    throw new ConfigurationError(
      'SUPABASE_URL must be a full URL starting with https:// (for example https://<project-ref>.supabase.co).',
    )
  }
  return { url, anonKey: requireEnv('SUPABASE_ANON_KEY') }
}

// Any S3-compatible private bucket works here. The R2_* names are kept from
// the original Cloudflare R2 plan; Supabase Storage's S3 endpoint is a
// drop-in alternative (set S3_REGION and S3_FORCE_PATH_STYLE=true for it).
export function getR2Config() {
  return {
    endpoint: requireEnv('R2_ENDPOINT'),
    bucket: requireEnv('R2_BUCKET_NAME'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    region: process.env.S3_REGION?.trim() || 'auto',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE?.trim().toLowerCase() === 'true',
  }
}

export function getUpstashConfig() {
  return {
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  }
}

export function getAnthropicConfig() {
  return {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    chatModel: requireEnv('ANTHROPIC_MODEL_CHAT'),
    generationModel: requireEnv('ANTHROPIC_MODEL_GENERATION'),
  }
}

// Groq is used for exactly one feature — the resume analyzer — never as a
// drop-in replacement for Claude. Keeping it behind its own getter makes
// that boundary obvious in every route that imports it.
export function getGroqConfig() {
  return {
    apiKey: requireEnv('GROQ_API_KEY'),
    model: process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile',
  }
}

/**
 * Which model powers chat, summaries, charts, plans and presentations.
 * "anthropic" (default) uses Claude; "groq" uses Groq instead. The resume
 * analyzer always uses Groq.
 */
export function getAiProvider(): 'anthropic' | 'groq' {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === 'groq' ? 'groq' : 'anthropic'
}

export type ExternalChatbotConfig = { url: string; apiKey: string | null }

/**
 * Optional — returns null when no external chatbot is configured, rather
 * than throwing, since the built-in Claude chat path works without it.
 * Set CHAT_PROVIDER=external to actually route chat through it once a URL
 * is configured (see api/_lib/externalChatbot.ts and the README).
 */
export function getExternalChatbotConfig(): ExternalChatbotConfig | null {
  const url = process.env.EXTERNAL_CHATBOT_URL?.trim()
  if (!url) return null
  const apiKey = process.env.EXTERNAL_CHATBOT_API_KEY?.trim()
  return { url, apiKey: apiKey || null }
}

export function getChatProvider(): 'anthropic' | 'external' {
  const provider = process.env.CHAT_PROVIDER?.trim().toLowerCase()
  return provider === 'external' ? 'external' : 'anthropic'
}
