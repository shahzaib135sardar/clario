import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, FileText, FileUp, Lock, MessageSquare, Quote, ShieldCheck, Sparkles } from 'lucide-react'
import { PageHero } from '../components/PageHero'
import { EmptyState } from '../components/EmptyState'
import { SkeletonList } from '../components/Skeleton'
import { featureFlags } from '../lib/featureFlags'
import { useReadyDocuments } from '../lib/useReadyDocuments'

/** Teaser while the flag is off; a simple "pick a document to chat with" entry once it is on. */
export function AiChatPage({ onUpload }: { onUpload: () => void }) {
  return featureFlags.aiChat ? <ChatEntry onUpload={onUpload} /> : <LockedChat />
}

function LockedChat() {
  return <motion.div className="chat-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
    <PageHero eyebrow="COMING SOON" title="AI chat, across everything." icon={MessageSquare} description="Ask questions across all of your documents at once and get answers you can trace back to the page." />
    <div className="locked-card">
      <span className="locked-badge"><Lock size={15} /> Locked for now</span>
      <h2>We&apos;re still polishing this one.</h2>
      <p>Cross-document chat isn&apos;t switched on yet. Until then you can chat with any single document: open it from your dashboard and use the chat panel beside the summary.</p>
      <ul className="locked-features">
        <li><Sparkles size={16} /><span><strong>Ask anything</strong><small>One question, every document in your workspace.</small></span></li>
        <li><Quote size={16} /><span><strong>Grounded answers</strong><small>Replies stay tied to what your documents actually say.</small></span></li>
        <li><ShieldCheck size={16} /><span><strong>Private by design</strong><small>Your files stay yours, same as everywhere else in Clario.</small></span></li>
      </ul>
      <Link className="button button-dark" to="/dashboard">Open a document to chat <ArrowRight size={15} /></Link>
    </div>
  </motion.div>
}

function ChatEntry({ onUpload }: { onUpload: () => void }) {
  const { documents, loading, error } = useReadyDocuments()
  return <motion.div className="chat-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
    <PageHero eyebrow="AI CHAT" title="Chat with a document." icon={MessageSquare} description="Pick a document and ask it anything. Answers come only from what it says." />
    {loading && <SkeletonList count={3} />}
    {!loading && error && <div className="upload-error" role="alert">{error}</div>}
    {!loading && !error && documents.length === 0 && <EmptyState icon={FileUp} title="No documents yet" action={<button className="button button-dark" onClick={onUpload}><FileUp size={16} /> Add a document</button>}>
      Add a PDF or Word document to start a conversation with it.
    </EmptyState>}
    {documents.length > 0 && <ul className="chat-doc-list">
      {documents.map((doc, index) => <li key={doc.id} style={{ '--i': Math.min(index, 8) } as React.CSSProperties}>
        <Link to={`/documents/${doc.id}`} className="chat-doc-row"><span className="file-icon file-ink"><FileText size={18} /></span><strong>{doc.fileName}</strong><ArrowRight size={15} /></Link>
      </li>)}
    </ul>}
  </motion.div>
}
