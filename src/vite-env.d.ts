/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" unlocks the AI chat page. Public build-time flag. */
  readonly VITE_FEATURE_AI_CHAT?: string
  /** Cloudflare Turnstile *site* key (public). The secret key lives only in Supabase's dashboard. */
  readonly VITE_TURNSTILE_SITE_KEY?: string
}
