import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'

/** Page heading with an icon chip and a soft gradient. `children` is the optional action slot. */
export function PageHero({
  eyebrow,
  title,
  description,
  icon: Icon,
  children,
  className = '',
}: {
  eyebrow: string
  title: ReactNode
  description: string
  icon: LucideIcon
  children?: ReactNode
  className?: string
}) {
  return <motion.div className={`page-hero ${className}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
    <span className="hero-icon" aria-hidden="true"><Icon size={22} /></span>
    <div className="hero-copy">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
    {children && <div className="hero-actions">{children}</div>}
  </motion.div>
}
