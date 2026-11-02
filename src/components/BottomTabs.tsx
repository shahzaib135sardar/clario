import { NavLink } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { getNavItems } from '../lib/navigation'

/** Phone-sized bottom navigation (shown by CSS at 760px and below). */
export function BottomTabs() {
  return <nav className="bottom-tabs" aria-label="Primary">
    {getNavItems().map((item) => <NavLink key={item.id} to={item.to} className={({ isActive }) => `bottom-tab ${isActive ? 'active' : ''}`}>
      <span className="bottom-tab-icon"><item.icon size={20} />{item.locked && <Lock size={9} className="bottom-tab-lock" aria-label="Coming soon" />}</span>
      <span>{item.shortLabel}</span>
    </NavLink>)}
  </nav>
}
