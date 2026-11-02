import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

function isValidSupabaseUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.hostname === 'localhost'
  } catch {
    return false
  }
}

export const supabaseConfigurationError = !isValidSupabaseUrl(supabaseUrl)
  ? 'Set a valid VITE_SUPABASE_URL to connect your Supabase project.'
  : !supabaseAnonKey
    ? 'Set VITE_SUPABASE_ANON_KEY to enable authentication.'
    : null

export const supabaseClient = supabaseConfigurationError
  ? null
  : createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })