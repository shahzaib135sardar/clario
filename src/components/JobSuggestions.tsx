import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Briefcase, Loader2, MapPin, RefreshCw, SearchX } from 'lucide-react'
import { getJobMatches, refreshJobMatches, type JobMatchesContent } from '../lib/api'
import { EmptyState } from './EmptyState'
import { SkeletonList } from './Skeleton'

const JOB_SOURCE_LINKS = [
  { label: 'Remotive', href: 'https://remotive.com' },
  { label: 'Arbeitnow', href: 'https://www.arbeitnow.com' },
  { label: 'Remote OK', href: 'https://remoteok.com' },
]
const JOB_SOURCE_LABELS: Record<string, string> = { remotive: 'Remotive', arbeitnow: 'Arbeitnow', remoteok: 'Remote OK' }

function formatPostedAgo(postedAt: string | null): string {
  if (!postedAt) return ''
  const days = Math.floor((Date.now() - Date.parse(postedAt)) / 86_400_000)
  if (!Number.isFinite(days) || days < 0) return ''
  if (days === 0) return 'Posted today'
  if (days === 1) return 'Posted yesterday'
  if (days < 30) return `Posted ${days} days ago`
  return `Posted ${Math.floor(days / 30)} mo ago`
}

export function JobSuggestions({ documentId }: { documentId: string }) {
  const [content, setContent] = useState<JobMatchesContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')

  const search = useCallback(async () => {
    setSearching(true)
    setError('')
    try {
      const { matches } = await refreshJobMatches(documentId)
      setContent(matches.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not find jobs right now.')
    } finally {
      setSearching(false)
    }
  }, [documentId])

  // Show what was found last time; the first time a resume is opened, go and find jobs for it.
  useEffect(() => {
    let cancelled = false
    getJobMatches(documentId)
      .then(({ matches }) => {
        if (cancelled) return
        if (matches) setContent(matches.content)
        else void search()
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load job suggestions.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, search])

  const busy = loading || searching
  const jobs = content?.jobs ?? []

  return <section className="jobs-panel" aria-labelledby="jobs-heading">
    <div className="jobs-header">
      <div>
        <h2 id="jobs-heading">Jobs that fit this resume</h2>
        <p>{content ? `Based on: ${content.profile.titles.slice(0, 3).join(', ') || content.profile.skills.slice(0, 4).join(', ')}` : 'We read your resume and look for open roles on free public job boards.'}</p>
      </div>
      <button className="button button-outline button-small" disabled={busy} onClick={() => void search()}>
        {busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} {searching ? 'Searching...' : 'Refresh'}
      </button>
    </div>

    {busy && !content && <>
      <div className="empty-search" role="status"><Loader2 size={16} className="spin" /> Finding jobs that match your resume...</div>
      <SkeletonList count={3} variant="card" />
    </>}
    {error && <div className="upload-error" role="alert">{error}</div>}
    {content && jobs.length === 0 && !busy && <EmptyState icon={SearchX} title="No close matches right now">
      The job boards have nothing close to this resume at the moment. New roles are posted daily, so check back soon.
    </EmptyState>}

    {jobs.length > 0 && <ul className="job-list">
      {jobs.map((job, index) => <li key={job.id} className="job-card" style={{ '--i': Math.min(index, 8) } as React.CSSProperties}>
        <span className="job-card-icon" aria-hidden="true"><Briefcase size={17} /></span>
        <div className="job-main">
          <h3>{job.title}</h3>
          <p className="job-meta">{[job.company, job.salary].filter(Boolean).join(' · ')}{job.location && <span className="job-location"><MapPin size={11} /> {job.location}</span>}</p>
          {job.snippet && <p className="job-snippet">{job.snippet}</p>}
          {job.matchedSkills.length > 0 && <div className="keyword-chips job-skills">{job.matchedSkills.map((skill) => <span key={skill}>{skill}</span>)}</div>}
          <p className="job-source">via {JOB_SOURCE_LABELS[job.source] ?? job.source}{formatPostedAgo(job.postedAt) && ` · ${formatPostedAgo(job.postedAt)}`}</p>
        </div>
        <div className="job-side">
          <span className="job-score" title="How closely this listing matches your resume">{job.score}% fit</span>
          {job.url.startsWith('https://') && <a className="button button-dark button-small" href={job.url} target="_blank" rel="noopener noreferrer">View job <ArrowRight size={14} /></a>}
        </div>
      </li>)}
    </ul>}

    <p className="resume-disclaimer">
      Listings come from {JOB_SOURCE_LINKS.map((source, index) => <span key={source.label}>{index > 0 && (index === JOB_SOURCE_LINKS.length - 1 ? ' and ' : ', ')}<a href={source.href} target="_blank" rel="noopener noreferrer">{source.label}</a></span>)}.
      "View job" opens the original listing on the board that published it, where you apply. Listings can change or close at any time, and nothing from your resume is shared with these sites.
    </p>
  </section>
}
