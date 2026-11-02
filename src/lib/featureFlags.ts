// Browser-side feature flags. Values come from build-time VITE_FEATURE_*
// variables, so they are public by design — never put anything secret here.

/** "true" / "1" / "yes" / "on" (any case) turn a flag on. Anything else, including unset, is off. */
export function parseFlag(value: unknown, fallback = false): boolean {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return fallback
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export const featureFlags = {
  /** Cross-document AI chat. Locked ("Soon") until VITE_FEATURE_AI_CHAT is true. */
  aiChat: parseFlag(import.meta.env.VITE_FEATURE_AI_CHAT, false),
}
