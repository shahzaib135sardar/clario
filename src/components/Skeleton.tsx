/** Shimmering placeholder rows shown while a list loads. Purely decorative, hidden from screen readers. */
export function SkeletonList({ count = 3, variant = 'row' }: { count?: number; variant?: 'row' | 'card' }) {
  return <div className={`skeleton-list skeleton-${variant}`} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <div key={index} className="skeleton-item" style={{ '--i': index } as React.CSSProperties}>
      <span className="skeleton skeleton-icon" />
      <span className="skeleton-lines"><span className="skeleton skeleton-line" /><span className="skeleton skeleton-line skeleton-line-short" /></span>
    </div>)}
  </div>
}
