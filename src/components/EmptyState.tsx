import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state">
    <span className="empty-state-icon" aria-hidden="true"><Icon size={22} /></span>
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action}
  </div>
}
