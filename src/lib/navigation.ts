import { Briefcase, FileSearch, LayoutDashboard, MessageSquare, Settings2, type LucideIcon } from 'lucide-react'
import { featureFlags } from './featureFlags'

export type NavItem = {
  id: 'overview' | 'resume' | 'jobs' | 'chat' | 'settings'
  to: string
  label: string
  shortLabel: string
  icon: LucideIcon
  /** True while the feature is switched off: shown with a lock and a "Soon" badge. */
  locked: boolean
}

export function getNavItems(): NavItem[] {
  return [
    { id: 'overview', to: '/dashboard', label: 'Overview', shortLabel: 'Home', icon: LayoutDashboard, locked: false },
    { id: 'resume', to: '/resume-analyzer', label: 'Resume analyzer', shortLabel: 'Resume', icon: FileSearch, locked: false },
    { id: 'jobs', to: '/jobs', label: 'Jobs', shortLabel: 'Jobs', icon: Briefcase, locked: false },
    { id: 'chat', to: '/ai-chat', label: 'AI chat', shortLabel: 'Chat', icon: MessageSquare, locked: !featureFlags.aiChat },
    { id: 'settings', to: '/settings', label: 'Settings', shortLabel: 'Settings', icon: Settings2, locked: false },
  ]
}

/** Title shown in the top bar's breadcrumb for the current path. */
export function sectionTitle(pathname: string): string {
  if (pathname.startsWith('/documents/')) return 'Document'
  if (pathname.startsWith('/settings')) return 'Settings'
  if (pathname.startsWith('/resume-analyzer')) return 'Resume analyzer'
  if (pathname.startsWith('/jobs')) return 'Jobs'
  if (pathname.startsWith('/ai-chat')) return 'AI chat'
  return 'Overview'
}
