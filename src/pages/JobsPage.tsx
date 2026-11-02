import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Briefcase, FileUp } from 'lucide-react'
import { PageHero } from '../components/PageHero'
import { EmptyState } from '../components/EmptyState'
import { SkeletonList } from '../components/Skeleton'
import { JobSuggestions } from '../components/JobSuggestions'
import { useReadyDocuments } from '../lib/useReadyDocuments'

export function JobsPage({ onUpload }: { onUpload: () => void }) {
  const { documents, loading, error } = useReadyDocuments()
  const [selectedId, setSelectedId] = useState('')

  useEffect(() => {
    if (documents.length > 0) setSelectedId((current) => current || documents[0].id)
  }, [documents])

  return <motion.div className="jobs-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
    <PageHero eyebrow="CAREER TOOLS" title="Jobs for you" icon={Briefcase} description="Pick a resume and Clario finds open roles that fit it, with a link to the original listing." />

    {loading && <SkeletonList count={2} variant="card" />}
    {!loading && error && <div className="upload-error" role="alert">{error}</div>}
    {!loading && !error && documents.length === 0 && <EmptyState icon={FileUp} title="Add your resume first" action={<button className="button button-dark" onClick={onUpload}><FileUp size={16} /> Upload a resume</button>}>
      Upload a PDF or Word resume and the best-fitting jobs will show up here. You can also <Link to="/dashboard">open your dashboard</Link>.
    </EmptyState>}

    {!loading && documents.length > 0 && <>
      <div className="jobs-picker">
        <label className="resume-field">
          <span>Resume</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            {documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.fileName}</option>)}
          </select>
        </label>
        <Link className="text-link" to="/resume-analyzer">Check this resume against a job description <span aria-hidden="true">→</span></Link>
      </div>
      {selectedId && <JobSuggestions key={selectedId} documentId={selectedId} />}
    </>}
  </motion.div>
}
