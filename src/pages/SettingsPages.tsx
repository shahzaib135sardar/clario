import { useState } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { BarChart3, ChevronDown, LogOut, Settings2, ShieldCheck, User as UserIcon, Building2 } from 'lucide-react'
import { PageHero } from '../components/PageHero'
import { useAuth } from '../auth/AuthProvider'
import { supabaseClient } from '../lib/supabase'
import { getDisplayName, getInitials } from '../lib/userDisplay'
import type { UsageCounts } from '../lib/api'

type Props = { showNotice: (message: string) => void; usage: UsageCounts | null }

const SECTIONS = [
  { to: 'profile', label: 'Profile', icon: UserIcon },
  { to: 'workspace', label: 'Workspace', icon: Building2 },
  { to: 'usage', label: 'Usage', icon: BarChart3 },
  { to: 'security', label: 'Security', icon: ShieldCheck },
]

/** Settings shell: heading + sub-navigation, with each section as its own routed page. */
export function SettingsPages({ showNotice, usage }: Props) {
  return <div className="settings-page">
    <PageHero eyebrow="YOUR ACCOUNT" title="Settings" icon={Settings2} description="Manage your profile, workspace, and preferences." />
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((section) => <NavLink key={section.to} to={`/settings/${section.to}`} className={({ isActive }) => (isActive ? 'settings-nav-active' : '')}><section.icon size={15} /><span>{section.label}</span></NavLink>)}
      </nav>
      <motion.div className="settings-content" key="settings-content" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <Routes>
          <Route index element={<Navigate to="profile" replace />} />
          <Route path="profile" element={<ProfileSection showNotice={showNotice} />} />
          <Route path="workspace" element={<WorkspaceSection showNotice={showNotice} />} />
          <Route path="usage" element={<UsageSection usage={usage} />} />
          <Route path="security" element={<SecuritySection showNotice={showNotice} />} />
          <Route path="*" element={<Navigate to="profile" replace />} />
        </Routes>
      </motion.div>
    </div>
  </div>
}

function ProfileSection({ showNotice }: { showNotice: Props['showNotice'] }) {
  const { user } = useAuth()
  const displayName = getDisplayName(user)
  return <section id="profile" className="settings-section"><div className="settings-section-heading"><div><h2>Profile</h2><p>Your personal details and sign-in information.</p></div><button className="button button-outline button-small" onClick={() => showNotice('Profile editing will be available soon.')}>Edit profile</button></div><div className="profile-detail"><span className="avatar profile-large">{getInitials(displayName)}</span><span><strong>{displayName}</strong><small>{user?.email}</small></span></div></section>
}

function WorkspaceSection({ showNotice }: { showNotice: Props['showNotice'] }) {
  return <section id="workspace" className="settings-section"><div className="settings-section-heading"><div><h2>Workspace</h2><p>Preferences for how Clario works with your documents.</p></div></div><div className="setting-row"><span><strong>Workspace name</strong><small>Shown to you in the navigation.</small></span><span className="setting-value">Personal space</span></div><div className="setting-row"><span><strong>Default document language</strong><small>Used for answers and generated content.</small></span><button className="setting-value setting-select" onClick={() => showNotice('Language preferences will be available soon.')}>English <ChevronDown size={14} /></button></div></section>
}

function UsageSection({ usage }: { usage: UsageCounts | null }) {
  return <section id="usage" className="settings-section"><div className="settings-section-heading"><div><h2>Usage this month</h2><p>A clear view of your recent activity.</p></div></div><div className="usage-stats"><div><strong>{usage ? usage.documents : '—'}</strong><span>Documents</span></div><div><strong>{usage ? usage.conversations : '—'}</strong><span>AI conversations</span></div><div><strong>{usage ? usage.artifacts : '—'}</strong><span>Generated items</span></div></div></section>
}

function SecuritySection({ showNotice }: { showNotice: Props['showNotice'] }) {
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = useState(false)

  async function signOut() {
    if (!supabaseClient) return
    setSigningOut(true)
    const { error } = await supabaseClient.auth.signOut()
    setSigningOut(false)
    if (error) {
      showNotice(error.message)
      return
    }
    navigate('/login', { replace: true })
  }

  return <section id="security" className="settings-section"><div className="settings-section-heading"><div><h2>Security</h2><p>Account security and session controls.</p></div></div><div className="setting-row"><span><strong>Sign-in method</strong><small>Email and password</small></span><span className="security-status"><ShieldCheck size={14} /> Protected</span></div><button className="signout-button" disabled={signingOut} onClick={() => void signOut()}><LogOut size={16} /> {signingOut ? 'Signing out...' : 'Sign out'}</button></section>
}
