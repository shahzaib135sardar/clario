import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { getSupabaseConfig } from './env'

/**
 * Builds a Supabase client scoped to one request's access token. Deliberately
 * uses the anon key, never a service-role key: every query made through this
 * client is still subject to the same Row-Level Security policies as the
 * browser, so a bug here can narrow access but can never silently bypass it.
 */
export function createRequestSupabaseClient(accessToken: string): SupabaseClient {
  const { url, anonKey } = getSupabaseConfig()
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export type AuthedRequest = {
  client: SupabaseClient
  user: User
}

/**
 * Verifies the bearer token against Supabase's own auth server (not a local
 * JWT decode) and returns both the verified user and a client already
 * carrying that user's credentials for any follow-up query.
 */
export async function authenticate(accessToken: string): Promise<AuthedRequest | null> {
  const client = createRequestSupabaseClient(accessToken)
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return { client, user: data.user }
}
