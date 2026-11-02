import type { User } from '@supabase/supabase-js'

export function getDisplayName(user: User | null): string {
  const fullName = user?.user_metadata.full_name
  return typeof fullName === 'string' && fullName.trim() ? fullName : user?.email ?? 'Account'
}

export function getInitials(name: string): string {
  return name.split(/[\s@]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A'
}
