import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAuth } from './auth/AuthProvider'
import { supabaseClient } from './lib/supabase'
import {
  deleteDocument,
  getDocument,
  listDocuments,
  getUsage,
  listChatMessages,
  sendChatMessage,
  getSummary,
  generateSummary,
  getChart,
  generateChart,
  getPlan,
  generatePlan,
  getPresentation,
  generatePresentation,
  getResumeAnalysis,
  generateResumeAnalysis,
  type DocumentSummary,
  type ChatMessage,
  type SummaryContent,
  type ChartContent,
  type PlanContent,
  type Presentation,
  type ResumeAnalysisContent,
  type UsageCounts,
} from './lib/api'
import { uploadDocument, FileValidationError, type UploadStage } from './lib/uploadDocument'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bell,
  Briefcase,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  FileChartColumnIncreasing,
  FileText,
  FileUp,
  FolderOpen,
  ListChecks,
  Loader2,
  LockKeyhole,
  Lock,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  FileSearch,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { PageHero } from './components/PageHero'
import { EmptyState } from './components/EmptyState'
import { SkeletonList } from './components/Skeleton'
import { BottomTabs } from './components/BottomTabs'
import { InstallPrompt } from './components/InstallPrompt'
import { Turnstile } from './components/Turnstile'
import { JobsPage } from './pages/JobsPage'
import { AiChatPage } from './pages/AiChatPage'
import { SettingsPages } from './pages/SettingsPages'
import { getNavItems, sectionTitle, type NavItem } from './lib/navigation'
import { getDisplayName, getInitials } from './lib/userDisplay'

type DocumentRecord = {
  id: string
  title: string
  type: 'PDF' | 'DOCX'
  updated: string
  size: string
  color: 'ink' | 'blue' | 'green' | 'red'
}

type ArtifactTab = 'summary' | 'charts' | 'plan' | 'presentation'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function formatDocumentDate(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const isSameDay = date.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = date.toDateString() === yesterday.toDateString()

  if (isSameDay) {
    return `Today, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  }
  if (isYesterday) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function toDocumentRecord(summary: DocumentSummary): DocumentRecord {
  const isPdf = summary.fileType === 'application/pdf'
  return {
    id: summary.id,
    title: summary.fileName,
    type: isPdf ? 'PDF' : 'DOCX',
    updated: formatDocumentDate(summary.createdAt),
    size: formatFileSize(summary.fileSize),
    color: isPdf ? 'red' : 'green',
  }
}

const tabs: { id: ArtifactTab; label: string; icon: typeof FileText }[] = [
  { id: 'summary', label: 'Summary', icon: FileText },
  { id: 'charts', label: 'Charts', icon: BarChart3 },
  { id: 'plan', label: 'Action plan', icon: ListChecks },
  { id: 'presentation', label: 'PowerPoint', icon: FileChartColumnIncreasing },
]

function App() {
  const location = useLocation()
  const isAuthPage = location.pathname === '/login' || location.pathname === '/signup'
  const { user, isLoading } = useAuth()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(true)
  const [documentsError, setDocumentsError] = useState('')
  const [usage, setUsage] = useState<UsageCounts | null>(null)

  function showNotice(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 3200)
  }

  const refreshDocuments = useCallback(async () => {
    setDocumentsLoading(true)
    try {
      const { documents: fetched } = await listDocuments()
      setDocuments(fetched)
      setDocumentsError('')
    } catch (error) {
      setDocumentsError(error instanceof Error ? error.message : 'Could not load your documents.')
    } finally {
      setDocumentsLoading(false)
    }
  }, [])

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await getUsage())
    } catch {
      // Usage figures are a nice-to-have on the dashboard, not worth surfacing an error for.
    }
  }, [])

  useEffect(() => {
    if (user) {
      void refreshDocuments()
      void refreshUsage()
    }
  }, [user, refreshDocuments, refreshUsage])

  async function handleDeleteDocument(documentId: string) {
    try {
      await deleteDocument(documentId)
      setDocuments((current) => current.filter((doc) => doc.id !== documentId))
      showNotice('Document deleted.')
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not delete this document.')
    }
  }

  if (isAuthPage) {
    return <AuthPage mode={location.pathname === '/signup' ? 'signup' : 'login'} />
  }

  if (isLoading) {
    return <div className="auth-page"><p className="auth-loading">Checking your session...</p></div>
  }

  if (!user || !supabaseClient) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  return (
    <div className="app-frame">
      <Sidebar mobileOpen={mobileNavOpen} closeMobile={() => setMobileNavOpen(false)} documentsCount={documents.length} />
      <div className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>
            <Menu size={19} />
          </button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{sectionTitle(location.pathname)}</strong></div>
          <div className="topbar-actions">
            <span className="preview-chip"><span /> Preview workspace</span>
            <button className="icon-button" aria-label="Notifications" onClick={() => showNotice('You’re all caught up.')}><Bell size={18} /></button>
            <button className="avatar" aria-label="Account menu" onClick={() => showNotice(user.email ?? 'Signed in')}>{getInitials(getDisplayName(user))}</button>
          </div>
        </header>

        <main className="page-content">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route
              path="/dashboard"
              element={
                <Dashboard
                  onUpload={() => setUploadOpen(true)}
                  showNotice={showNotice}
                  documents={documents}
                  isLoading={documentsLoading}
                  loadError={documentsError}
                  onRetry={refreshDocuments}
                  onDelete={handleDeleteDocument}
                  usage={usage}
                />
              }
            />
            <Route path="/documents/:id" element={<DocumentWorkspace showNotice={showNotice} />} />
            <Route path="/resume-analyzer" element={<ResumeAnalyzer showNotice={showNotice} />} />
            <Route path="/jobs" element={<JobsPage onUpload={() => setUploadOpen(true)} />} />
            <Route path="/ai-chat" element={<AiChatPage onUpload={() => setUploadOpen(true)} />} />
            <Route path="/settings/*" element={<SettingsPages showNotice={showNotice} usage={usage} />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>

      <AnimatePresence>
        {uploadOpen && (
          <UploadDialog
            close={() => setUploadOpen(false)}
            onUploaded={(document) => {
              setDocuments((current) => [document, ...current.filter((doc) => doc.id !== document.id)])
              showNotice(`${document.fileName} is ready.`)
            }}
          />
        )}
      </AnimatePresence>
      <BottomTabs />
      <InstallPrompt />
      <AnimatePresence>
        {notice && <motion.div className="toast" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>{notice}</motion.div>}
      </AnimatePresence>
    </div>
  )
}

function Sidebar({ mobileOpen, closeMobile, documentsCount }: { mobileOpen: boolean; closeMobile: () => void; documentsCount: number }) {
  const { user } = useAuth()
  const displayName = getDisplayName(user)
  return <>
    <button className={`sidebar-scrim ${mobileOpen ? 'visible' : ''}`} aria-label="Close navigation" onClick={closeMobile} />
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <Link to="/dashboard" className="brand" onClick={closeMobile}><span className="brand-mark">c</span><span>clario</span></Link>
      <div className="workspace-switcher">
        <span className="workspace-icon"><FolderOpen size={16} /></span>
        <span className="switcher-copy"><strong>Personal space</strong><small>Free workspace</small></span>
        <ChevronDown size={15} className="switcher-chevron" />
      </div>
      <div className="side-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        {getNavItems().filter((item) => item.id !== 'settings').map((item) => <SidebarLink key={item.id} item={item} closeMobile={closeMobile} badge={item.id === 'overview' ? String(documentsCount) : undefined} />)}
      </nav>
      <div className="side-label side-label-spaced">PREFERENCES</div>
      <nav className="side-nav" aria-label="Preferences">
        {getNavItems().filter((item) => item.id === 'settings').map((item) => <SidebarLink key={item.id} item={item} closeMobile={closeMobile} />)}
        <button className="nav-link" onClick={closeMobile}><CircleHelp size={17} /><span>Help center</span><ArrowRight size={14} className="nav-trailing" /></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="usage-box"><div className="usage-head"><span>Storage</span><span>2.8 / 10 GB</span></div><div className="usage-track"><span /></div><small>Plenty of room to work.</small></div>
        <button className="profile-row"><span className="avatar avatar-small">{getInitials(displayName)}</span><span className="profile-copy"><strong>{displayName}</strong><small>{user?.email}</small></span><MoreHorizontal size={18} /></button>
      </div>
    </aside>
  </>
}

function SidebarLink({ item, closeMobile, badge }: { item: NavItem; closeMobile: () => void; badge?: string }) {
  return <NavLink to={item.to} onClick={closeMobile} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
    {({ isActive }) => <>
      {isActive && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
      <item.icon size={17} /><span>{item.label}</span>
      {item.locked && <span className="nav-soon"><Lock size={10} /> Soon</span>}
      {badge !== undefined && <span className="nav-count">{badge}</span>}
    </>}
  </NavLink>
}

function Dashboard({
  onUpload,
  showNotice,
  documents,
  isLoading,
  loadError,
  onRetry,
  onDelete,
  usage,
}: {
  onUpload: () => void
  showNotice: (message: string) => void
  documents: DocumentSummary[]
  isLoading: boolean
  loadError: string
  onRetry: () => void
  onDelete: (documentId: string) => void
  usage: UsageCounts | null
}) {
  const [query, setQuery] = useState('')
  const records = documents.map(toDocumentRecord)
  const filtered = records.filter((document) => document.title.toLowerCase().includes(query.toLowerCase()))
  const lastOpened = records[0]

  return <motion.div className="dashboard-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
    <PageHero className="dashboard-heading" icon={FolderOpen} eyebrow="YOUR WORKSPACE" title={<>Your documents,<br className="mobile-break" /> in focus.</>} description="Bring the important details forward. Start with a document or pick up where you left off.">
      <button className="button button-dark" onClick={onUpload}><Plus size={17} /> Add a document</button>
    </PageHero>

    <section className="metric-strip" aria-label="Workspace summary">
      <div className="metric"><span className="metric-label">Documents</span><div><strong>{String(records.length).padStart(2, '0')}</strong><span className="metric-note">in your workspace</span></div></div>
      <div className="metric"><span className="metric-label">Last opened</span><div><strong className="metric-text">{lastOpened ? lastOpened.title : 'No documents yet'}</strong><span className="metric-note">{lastOpened ? lastOpened.updated : 'Upload one to get started'}</span></div></div>
      <div className="metric"><span className="metric-label">Work created</span><div><strong>{usage ? usage.artifacts : '—'}</strong><span className="metric-note">answers and artifacts</span></div></div>
      <div className="metric metric-mark"><span className="metric-stamp"><Sparkles size={16} /></span><span className="metric-note">A little more clarity,<br />one document at a time.</span></div>
    </section>

    <section className="documents-section">
      <div className="section-heading"><div><div className="eyebrow">YOUR LIBRARY</div><h2>Recent documents</h2></div><Link className="text-link" to="/dashboard">View all <ArrowRight size={15} /></Link></div>
      <div className="document-toolbar"><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a document" aria-label="Find a document" /><kbd>⌘ K</kbd></label><button className="filter-button" onClick={() => showNotice('Filters will be available with document sync.')}><span>Recently updated</span><ChevronDown size={15} /></button></div>
      <div className="document-list">
        <div className="document-list-head"><span>NAME</span><span>TYPE</span><span>LAST OPENED</span><span>SIZE</span><span /></div>
        {isLoading && <><div className="empty-search" role="status"><Loader2 size={16} className="spin" /> Loading your documents...</div><SkeletonList count={3} /></>}
        {!isLoading && loadError && (
          <div className="empty-search">{loadError} <button className="text-link" onClick={onRetry}>Try again</button></div>
        )}
        {!isLoading && !loadError && filtered.map((document, index) => (
          <DocumentRow key={document.id} document={document} onDelete={onDelete} index={index} />
        ))}
        {!isLoading && !loadError && filtered.length === 0 && records.length > 0 && (
          <div className="empty-search">No documents match "{query}".</div>
        )}
        {!isLoading && !loadError && records.length === 0 && (
          <EmptyState icon={FileUp} title="No documents yet" action={<button className="button button-dark" onClick={onUpload}><Plus size={16} /> Add your first document</button>}>Add a PDF or DOCX to get summaries, charts, plans and answers from it.</EmptyState>
        )}
      </div>
      <button className="drop-hint" onClick={onUpload}><span className="drop-icon"><Upload size={17} /></span><span><strong>Have another document?</strong><small>PDF or DOCX, up to 25 MB</small></span><span className="drop-action">Upload <ArrowRight size={14} /></span></button>
    </section>

    <div className="dashboard-footer"><ShieldCheck size={15} /><span>Your workspace is private. Your documents stay yours.</span><button onClick={() => showNotice('Privacy controls are coming with account setup.')}>Privacy details</button></div>
  </motion.div>
}

function DocumentRow({ document, onDelete, index }: { document: DocumentRecord; onDelete: (documentId: string) => void; index: number }) {
  return <Link className="document-row" style={{ '--i': Math.min(index, 8) } as React.CSSProperties} to={`/documents/${document.id}`}>
    <span className="document-name"><span className={`file-icon file-${document.color}`}><FileText size={18} /></span><span className="document-copy"><strong>{document.title}</strong><small>{document.size}</small></span></span>
    <span className="file-type">{document.type}</span><span className="document-date">{document.updated}</span><span className="document-size">{document.size}</span>
    <button
      className="icon-button row-delete"
      aria-label={`Delete ${document.title}`}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (window.confirm(`Delete "${document.title}"? This cannot be undone.`)) onDelete(document.id)
      }}
    >
      <Trash2 size={15} />
    </button>
    <ChevronRight size={16} className="row-chevron" />
  </Link>
}

// --- Document workspace: chat + generated artifacts (Milestones 4-6) -----

type ArtifactSlot<T> = { data: T | null; loading: boolean; generating: boolean; error: string; loaded: boolean }
const emptySlot = <T,>(): ArtifactSlot<T> => ({ data: null, loading: false, generating: false, error: '', loaded: false })

function DocumentWorkspace({ showNotice }: { showNotice: (message: string) => void }) {
  const { id = '' } = useParams()
  const [document, setDocument] = useState<DocumentRecord | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not-found' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setLoadState('loading')
    getDocument(id)
      .then(({ document: summary }) => {
        if (cancelled) return
        setDocument(toDocumentRecord(summary))
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const status = error instanceof Error && 'status' in error ? (error as { status?: number }).status : undefined
        setLoadState(status === 404 ? 'not-found' : 'error')
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const [activeTab, setActiveTab] = useState<ArtifactTab>('summary')

  // --- Chat ---
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatLoading, setChatLoading] = useState(true)
  const [chatError, setChatError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (loadState !== 'ready') return
    let cancelled = false
    setChatLoading(true)
    listChatMessages(id)
      .then(({ messages: fetched }) => {
        if (cancelled) return
        setMessages(fetched)
        setChatError('')
      })
      .catch((error: unknown) => {
        if (!cancelled) setChatError(error instanceof Error ? error.message : 'Could not load this conversation.')
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, loadState])

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    setSending(true)
    setChatError('')
    try {
      const result = await sendChatMessage(id, text)
      setMessages((current) => [
        ...current,
        result.userMessage,
        ...(result.assistantMessage ? [result.assistantMessage] : []),
      ])
      if (!result.assistantMessage) setChatError(result.error ?? 'The assistant could not reply. Please try again.')
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Could not send this message.')
    } finally {
      setSending(false)
    }
  }

  // --- Generated artifacts ---
  const [summarySlot, setSummarySlot] = useState<ArtifactSlot<SummaryContent>>(emptySlot())
  const [chartSlot, setChartSlot] = useState<ArtifactSlot<ChartContent>>(emptySlot())
  const [planSlot, setPlanSlot] = useState<ArtifactSlot<PlanContent>>(emptySlot())
  const [pptSlot, setPptSlot] = useState<ArtifactSlot<Presentation>>(emptySlot())
  const [checkedSteps, setCheckedSteps] = useState<number[]>([])

  useEffect(() => {
    if (loadState !== 'ready') return

    if (activeTab === 'summary' && !summarySlot.loaded && !summarySlot.loading) {
      setSummarySlot((s) => ({ ...s, loading: true }))
      getSummary(id)
        .then(({ summary }) => setSummarySlot({ data: summary?.content ?? null, loading: false, generating: false, error: '', loaded: true }))
        .catch((error: unknown) => setSummarySlot((s) => ({ ...s, loading: false, loaded: true, error: error instanceof Error ? error.message : 'Could not load the summary.' })))
    }
    if (activeTab === 'charts' && !chartSlot.loaded && !chartSlot.loading) {
      setChartSlot((s) => ({ ...s, loading: true }))
      getChart(id)
        .then(({ chart }) => setChartSlot({ data: chart?.content ?? null, loading: false, generating: false, error: '', loaded: true }))
        .catch((error: unknown) => setChartSlot((s) => ({ ...s, loading: false, loaded: true, error: error instanceof Error ? error.message : 'Could not load the chart.' })))
    }
    if (activeTab === 'plan' && !planSlot.loaded && !planSlot.loading) {
      setPlanSlot((s) => ({ ...s, loading: true }))
      getPlan(id)
        .then(({ plan }) => setPlanSlot({ data: plan?.content ?? null, loading: false, generating: false, error: '', loaded: true }))
        .catch((error: unknown) => setPlanSlot((s) => ({ ...s, loading: false, loaded: true, error: error instanceof Error ? error.message : 'Could not load the plan.' })))
    }
    if (activeTab === 'presentation' && !pptSlot.loaded && !pptSlot.loading) {
      setPptSlot((s) => ({ ...s, loading: true }))
      getPresentation(id)
        .then(({ presentation }) => setPptSlot({ data: presentation, loading: false, generating: false, error: '', loaded: true }))
        .catch((error: unknown) => setPptSlot((s) => ({ ...s, loading: false, loaded: true, error: error instanceof Error ? error.message : 'Could not load the presentation.' })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, loadState, id])

  async function handleGenerateSummary() {
    setSummarySlot((s) => ({ ...s, generating: true, error: '' }))
    try {
      const { summary } = await generateSummary(id)
      setSummarySlot({ data: summary.content, loading: false, generating: false, error: '', loaded: true })
    } catch (error) {
      setSummarySlot((s) => ({ ...s, generating: false, error: error instanceof Error ? error.message : 'Could not generate a summary.' }))
    }
  }
  async function handleGenerateChart() {
    setChartSlot((s) => ({ ...s, generating: true, error: '' }))
    try {
      const { chart } = await generateChart(id)
      setChartSlot({ data: chart.content, loading: false, generating: false, error: '', loaded: true })
    } catch (error) {
      setChartSlot((s) => ({ ...s, generating: false, error: error instanceof Error ? error.message : 'Could not generate a chart.' }))
    }
  }
  async function handleGeneratePlan() {
    setPlanSlot((s) => ({ ...s, generating: true, error: '' }))
    try {
      const { plan } = await generatePlan(id)
      setPlanSlot({ data: plan.content, loading: false, generating: false, error: '', loaded: true })
      setCheckedSteps([])
    } catch (error) {
      setPlanSlot((s) => ({ ...s, generating: false, error: error instanceof Error ? error.message : 'Could not generate a plan.' }))
    }
  }
  async function handleGeneratePresentation() {
    setPptSlot((s) => ({ ...s, generating: true, error: '' }))
    try {
      const { presentation } = await generatePresentation(id)
      setPptSlot({ data: presentation, loading: false, generating: false, error: '', loaded: true })
    } catch (error) {
      setPptSlot((s) => ({ ...s, generating: false, error: error instanceof Error ? error.message : 'Could not generate a presentation.' }))
    }
  }

  if (loadState === 'loading') {
    return <div className="workspace-page"><div className="empty-search"><Loader2 size={16} className="spin" /> Loading document...</div></div>
  }
  if (loadState === 'not-found') {
    return <div className="workspace-page"><div className="empty-search">That document couldn't be found. <Link className="text-link" to="/dashboard">Back to documents</Link></div></div>
  }
  if (loadState === 'error' || !document) {
    return <div className="workspace-page"><div className="empty-search">Could not load this document. <Link className="text-link" to="/dashboard">Back to documents</Link></div></div>
  }

  const title = document.title

  return <motion.div className="workspace-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
    <div className="workspace-topline"><Link to="/dashboard" className="back-link"><ArrowLeft size={15} /> Documents</Link><div className="workspace-actions"><span className="saved-status"><Check size={13} /> Saved</span><button className="icon-button" aria-label="More document actions" onClick={() => showNotice('Document actions will be connected to your account.')}><MoreHorizontal size={19} /></button></div></div>
    <div className="doc-title-row"><div><div className="eyebrow">{document.type} DOCUMENT <span className="dot-divider">·</span> ADDED {document.updated.toUpperCase()}</div><h1>{title}</h1></div><button className="button button-outline" onClick={() => showNotice('Original-file download is not part of this milestone — only the extracted text is used.')}><ArrowDownToLine size={16} /> Original file</button></div>
    <div className="workspace-grid">
      <section className="chat-panel" aria-label="Document assistant">
        <div className="panel-header"><div className="assistant-mark"><Sparkles size={16} /></div><div><strong>Ask Clario</strong><small>Grounded in this document</small></div><button className="icon-button panel-more" aria-label="Chat options" onClick={() => showNotice('Chat options will be available soon.')}><MoreHorizontal size={18} /></button></div>
        <div className="chat-context"><LockKeyhole size={13} /><span>Answers are based on <strong>{title}</strong></span></div>
        <div className="messages" aria-live="polite">
          {chatLoading && <div className="empty-search"><Loader2 size={16} className="spin" /> Loading conversation...</div>}
          {!chatLoading && messages.length === 0 && <div className="empty-search">Ask a question about this document to get started.</div>}
          {!chatLoading && messages.map((message) => (
            <div className={`message message-${message.role}`} key={message.id}>
              <div className="message-avatar">{message.role === 'assistant' ? <Sparkles size={13} /> : 'You'.slice(0, 2)}</div>
              <div className="message-body">
                <span className="message-author">{message.role === 'assistant' ? 'Clario' : 'You'} <time>{formatTime(message.created_at)}</time></span>
                <p>{message.content}</p>
              </div>
            </div>
          ))}
          {sending && <div className="message message-assistant"><div className="message-avatar"><Sparkles size={13} /></div><div className="message-body"><span className="message-author">Clario</span><p className="typing-indicator"><Loader2 size={12} className="spin" /> Thinking...</p></div></div>}
        </div>
        {chatError && <div className="upload-error chat-inline-error" role="alert">{chatError}</div>}
        <form className="chat-composer" onSubmit={submitMessage}><textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="Ask anything about this document..." aria-label="Ask about this document" disabled={sending} /><div className="composer-foot"><span>Answers are grounded in this document's extracted text</span><button className="send-button" type="submit" aria-label="Send message" disabled={!draft.trim() || sending}>{sending ? <Loader2 size={15} className="spin" /> : <Send size={16} />}</button></div></form>
      </section>

      <section className="artifact-panel" aria-label="Document tools and results">
        <div className="artifact-header"><div><div className="eyebrow">MAKE SOMETHING OF IT</div><h2>Work with this document</h2></div><button className="icon-button" aria-label="Artifact options" onClick={() => showNotice('Artifact settings will be available soon.')}><MoreHorizontal size={18} /></button></div>
        <div className="artifact-tabs" role="tablist" aria-label="Generated document tools">{tabs.map((tab) => { const Icon = tab.icon; return <button key={tab.id} className={`artifact-tab ${activeTab === tab.id ? 'selected' : ''}`} role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}><Icon size={15} /><span>{tab.label}</span></button> })}</div>
        <ArtifactContent
          activeTab={activeTab}
          summarySlot={summarySlot}
          chartSlot={chartSlot}
          planSlot={planSlot}
          pptSlot={pptSlot}
          checkedSteps={checkedSteps}
          setCheckedSteps={setCheckedSteps}
          onGenerateSummary={handleGenerateSummary}
          onGenerateChart={handleGenerateChart}
          onGeneratePlan={handleGeneratePlan}
          onGeneratePresentation={handleGeneratePresentation}
        />
      </section>
    </div>
  </motion.div>
}

const DocumentBarChart = lazy(() => import('./components/DocumentBarChart'))

function GenerateEmptyState({ label, onGenerate, generating }: { label: string; onGenerate: () => void; generating: boolean }) {
  return <div className="artifact-empty">
    <Sparkles size={18} />
    <p>Nothing generated yet for this document.</p>
    <button className="button button-dark" disabled={generating} onClick={onGenerate}>{generating ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {generating ? 'Generating...' : label}</button>
  </div>
}

function ArtifactContent({
  activeTab,
  summarySlot,
  chartSlot,
  planSlot,
  pptSlot,
  checkedSteps,
  setCheckedSteps,
  onGenerateSummary,
  onGenerateChart,
  onGeneratePlan,
  onGeneratePresentation,
}: {
  activeTab: ArtifactTab
  summarySlot: ArtifactSlot<SummaryContent>
  chartSlot: ArtifactSlot<ChartContent>
  planSlot: ArtifactSlot<PlanContent>
  pptSlot: ArtifactSlot<Presentation>
  checkedSteps: number[]
  setCheckedSteps: (steps: number[]) => void
  onGenerateSummary: () => void
  onGenerateChart: () => void
  onGeneratePlan: () => void
  onGeneratePresentation: () => void
}) {
  if (activeTab === 'summary') {
    if (summarySlot.loading) return <div className="artifact-content"><div className="empty-search"><Loader2 size={16} className="spin" /> Loading summary...</div></div>
    if (summarySlot.error && !summarySlot.data) return <div className="artifact-content"><div className="empty-search">{summarySlot.error}</div></div>
    if (!summarySlot.data) return <div className="artifact-content"><GenerateEmptyState label="Generate summary" onGenerate={onGenerateSummary} generating={summarySlot.generating} /></div>
    const { headline, lede, points } = summarySlot.data
    return <div className="artifact-content">
      <div className="artifact-toolbar"><span className="generated-label"><CheckCircle2 size={14} /> EXECUTIVE SUMMARY</span><button className="text-icon-button" disabled={summarySlot.generating} onClick={onGenerateSummary} aria-label="Regenerate summary">{summarySlot.generating ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}</button></div>
      <h3>{headline}</h3>
      <p className="artifact-lede">{lede}</p>
      <div className="summary-rule" />
      <h4>What matters</h4>
      <ul className="summary-points">{points.map((point, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span><p><strong>{point.title}.</strong> {point.body}</p></li>)}</ul>
      {summarySlot.error && <div className="upload-error">{summarySlot.error}</div>}
      <div className="artifact-meta"><span><Clock3 size={13} /> Generated from this document</span></div>
    </div>
  }

  if (activeTab === 'charts') {
    if (chartSlot.loading) return <div className="artifact-content"><div className="empty-search"><Loader2 size={16} className="spin" /> Loading chart...</div></div>
    if (chartSlot.error && !chartSlot.data) return <div className="artifact-content"><div className="empty-search">{chartSlot.error}</div></div>
    if (!chartSlot.data) return <div className="artifact-content"><GenerateEmptyState label="Generate chart" onGenerate={onGenerateChart} generating={chartSlot.generating} /></div>
    const { title, lede, totalLabel, totalValue, sourceNote, series } = chartSlot.data
    return <div className="artifact-content">
      <div className="artifact-toolbar"><span className="generated-label"><BarChart3 size={14} /> {title.toUpperCase()}</span><button className="text-icon-button" disabled={chartSlot.generating} onClick={onGenerateChart} aria-label="Regenerate chart">{chartSlot.generating ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}</button></div>
      <p className="artifact-lede chart-lede-top">{lede}</p>
      {totalValue && <div className="chart-total"><span>{totalLabel}</span><strong>{totalValue}</strong></div>}
      <Suspense fallback={<div className="empty-search"><Loader2 size={16} className="spin" /> Loading chart renderer...</div>}>
        <DocumentBarChart series={series} />
      </Suspense>
      {chartSlot.error && <div className="upload-error">{chartSlot.error}</div>}
      <div className="artifact-meta"><span><FileText size={13} /> {sourceNote || 'Generated from this document'}</span></div>
    </div>
  }

  if (activeTab === 'plan') {
    if (planSlot.loading) return <div className="artifact-content"><div className="empty-search"><Loader2 size={16} className="spin" /> Loading plan...</div></div>
    if (planSlot.error && !planSlot.data) return <div className="artifact-content"><div className="empty-search">{planSlot.error}</div></div>
    if (!planSlot.data) return <div className="artifact-content"><GenerateEmptyState label="Generate action plan" onGenerate={onGeneratePlan} generating={planSlot.generating} /></div>
    const { title, lede, tasks } = planSlot.data
    return <div className="artifact-content">
      <div className="artifact-toolbar"><span className="generated-label"><ListChecks size={14} /> SUGGESTED NEXT STEPS</span><button className="text-icon-button" disabled={planSlot.generating} onClick={onGeneratePlan} aria-label="Regenerate plan">{planSlot.generating ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}</button></div>
      <h3>{title}</h3>
      <p className="artifact-lede">{lede}</p>
      <div className="plan-list">{tasks.map((task, index) => <label className={`plan-task ${checkedSteps.includes(index) ? 'task-done' : ''}`} key={index}><input type="checkbox" checked={checkedSteps.includes(index)} onChange={() => setCheckedSteps(checkedSteps.includes(index) ? checkedSteps.filter((step) => step !== index) : [...checkedSteps, index])} /><span className="custom-check">{checkedSteps.includes(index) && <Check size={12} />}</span><span className="task-text"><strong>{task.task}</strong><small>{task.note} · {task.estimatedMinutes} min</small></span></label>)}</div>
      {planSlot.error && <div className="upload-error">{planSlot.error}</div>}
      <div className="artifact-meta"><span>{checkedSteps.length} of {tasks.length} completed</span></div>
    </div>
  }

  // presentation
  if (pptSlot.loading) return <div className="artifact-content ppt-content"><div className="empty-search"><Loader2 size={16} className="spin" /> Loading presentation...</div></div>
  if (!pptSlot.data) {
    return <div className="artifact-content ppt-content">
      <span className="generated-label"><FileChartColumnIncreasing size={14} /> PRESENTATION OUTLINE</span>
      <h3>Bring the analysis into the room.</h3>
      <p className="artifact-lede">Generate a polished, editable deck from this document in your browser.</p>
      <div className="ppt-details"><span>6-9 slides</span><span>Executive briefing</span><span>Editable .pptx</span></div>
      <button className="button button-dark button-wide" disabled={pptSlot.generating} onClick={onGeneratePresentation}>{pptSlot.generating ? <Loader2 size={16} className="spin" /> : <FileChartColumnIncreasing size={16} />} {pptSlot.generating ? 'Generating deck...' : 'Generate presentation'}</button>
      {pptSlot.error && <div className="upload-error">{pptSlot.error}</div>}
    </div>
  }
  const { content, downloadUrl, createdAt } = pptSlot.data
  return <div className="artifact-content ppt-content">
    <span className="generated-label"><FileChartColumnIncreasing size={14} /> PRESENTATION READY</span>
    <h3>{content.deckTitle}</h3>
    <p className="artifact-lede">{content.deckSubtitle || `A ${content.slideCount}-slide deck generated from this document.`}</p>
    <div className="ppt-details"><span>{content.slideCount} slides</span><span>Editable .pptx</span><span>Generated {formatDocumentDate(createdAt)}</span></div>
    <a className="button button-dark button-wide" href={downloadUrl}><Download size={16} /> Download .pptx</a>
    <button className="button button-outline button-wide ppt-regen" disabled={pptSlot.generating} onClick={onGeneratePresentation}>{pptSlot.generating ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} {pptSlot.generating ? 'Regenerating...' : 'Regenerate deck'}</button>
    {pptSlot.error && <div className="upload-error">{pptSlot.error}</div>}
  </div>
}

// --- Resume analyzer ------------------------------------------------------

function ResumeAnalyzer({ showNotice }: { showNotice: (message: string) => void }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(true)
  const [documentsError, setDocumentsError] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [analysis, setAnalysis] = useState<ResumeAnalysisContent | null>(null)
  const [loadingAnalysis, setLoadingAnalysis] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    listDocuments()
      .then(({ documents: fetched }) => {
        const ready = fetched.filter((doc) => doc.status === 'ready')
        setDocuments(ready)
        if (ready.length > 0) setSelectedId((current) => current || ready[0].id)
      })
      .catch((error: unknown) => setDocumentsError(error instanceof Error ? error.message : 'Could not load your documents.'))
      .finally(() => setDocumentsLoading(false))
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setAnalysis(null)
      return
    }
    let cancelled = false
    setLoadingAnalysis(true)
    getResumeAnalysis(selectedId)
      .then(({ analysis: fetched }) => {
        if (cancelled) return
        setAnalysis(fetched?.content ?? null)
        if (fetched?.content.jobDescription) setJobDescription(fetched.content.jobDescription)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadingAnalysis(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  async function analyze() {
    if (!selectedId || !jobDescription.trim() || analyzing) return
    setAnalyzing(true)
    setError('')
    try {
      const { analysis: result } = await generateResumeAnalysis(selectedId, jobDescription.trim())
      setAnalysis(result.content)
      showNotice('Analysis complete.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not analyze this resume.')
    } finally {
      setAnalyzing(false)
    }
  }

  return <motion.div className="resume-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
    <PageHero eyebrow="CAREER TOOLS" title="Resume analyzer" icon={FileSearch} description="Compare one of your uploaded resumes against a job description and see exactly where it falls short." />

    <div className="resume-grid">
      <section className="resume-input-panel">
        <label className="resume-field">
          <span>Resume</span>
          {documentsLoading ? <div className="empty-search"><Loader2 size={16} className="spin" /> Loading your documents...</div>
            : documentsError ? <div className="empty-search">{documentsError}</div>
            : documents.length === 0 ? <div className="empty-search">Upload a PDF or Word resume from your dashboard first, then come back here.</div>
            : <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                {documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.fileName}</option>)}
              </select>}
        </label>
        <label className="resume-field">
          <span>Job description</span>
          <textarea rows={11} value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="Paste the job description you're targeting..." />
        </label>
        {error && <div className="upload-error" role="alert">{error}</div>}
        <button className="button button-dark button-wide" disabled={!selectedId || !jobDescription.trim() || analyzing} onClick={() => void analyze()}>
          {analyzing ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} {analyzing ? 'Analyzing...' : 'Analyze fit'}
        </button>
        <p className="resume-disclaimer">Analysis is generated by an AI model and may be imperfect — use it as a starting point, not a final verdict.</p>
      </section>

      <section className="resume-results-panel">
        {loadingAnalysis && <><div className="empty-search" role="status"><Loader2 size={16} className="spin" /> Loading previous analysis...</div><SkeletonList count={2} /></>}
        {!loadingAnalysis && !analysis && <EmptyState icon={Sparkles} title="No analysis yet">Your analysis will appear here once you run it.</EmptyState>}
        {!loadingAnalysis && analysis && <ResumeAnalysisResult analysis={analysis} />}
      </section>
    </div>

    {selectedId && <Link className="jobs-link-card" to="/jobs"><span className="jobs-link-icon"><Briefcase size={18} /></span><span><strong>Find jobs for this resume</strong><small>See open roles that fit it, with links to the original listings.</small></span><ArrowRight size={16} /></Link>}
  </motion.div>
}

function ResumeAnalysisResult({ analysis }: { analysis: ResumeAnalysisContent }) {
  return <div className="resume-result">
    <div className="score-meter">
      <div className="score-ring" style={{ '--score': analysis.matchScore } as React.CSSProperties}><strong>{analysis.matchScore}</strong><span>/ 100</span></div>
      <div><strong>Match score</strong><p>{analysis.summary}</p></div>
    </div>
    <div className="resume-columns">
      <div><h4>Strengths</h4>{analysis.strengths.length === 0 ? <p className="resume-empty-note">None identified.</p> : <ul className="resume-list resume-list-good">{analysis.strengths.map((item, index) => <li key={index}>{item}</li>)}</ul>}</div>
      <div><h4>Gaps</h4>{analysis.gaps.length === 0 ? <p className="resume-empty-note">None identified.</p> : <ul className="resume-list resume-list-bad">{analysis.gaps.map((item, index) => <li key={index}>{item}</li>)}</ul>}</div>
    </div>
    {analysis.missingKeywords.length > 0 && <div className="resume-keywords"><h4>Missing keywords</h4><div className="keyword-chips">{analysis.missingKeywords.map((keyword, index) => <span key={index}>{keyword}</span>)}</div></div>}
    <div><h4>Suggestions</h4><ul className="resume-list">{analysis.suggestions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
  </div>
}

function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, isLoading, configurationError } = useAuth()
  const isSignup = mode === 'signup'
  const isRecovery = new URLSearchParams(location.search).get('recovery') === '1'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim()
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [captchaReset, setCaptchaReset] = useState(0)
  const captchaRequired = turnstileSiteKey !== '' && !isRecovery

  if (user && !isRecovery) return <Navigate to="/dashboard" replace />

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) {
      setFeedback(configurationError ?? 'Supabase is not configured.')
      return
    }

    if (captchaRequired && !captchaToken) {
      setFeedback('Please complete the verification first.')
      return
    }

    setBusy(true)
    setFeedback('')

    if (isRecovery) {
      const { error } = await supabaseClient.auth.updateUser({ password })
      setBusy(false)
      if (error) setFeedback(error.message)
      else navigate('/dashboard', { replace: true })
      return
    }

    if (isSignup) {
      const { data, error } = await supabaseClient.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: fullName.trim() },
          emailRedirectTo: `${window.location.origin}/dashboard`,
          ...(captchaToken ? { captchaToken } : {}),
        },
      })
      setBusy(false)
      if (captchaRequired) setCaptchaReset((n) => n + 1) // tokens are single-use
      if (error) setFeedback(error.message)
      else if (data.session) navigate('/dashboard', { replace: true })
      else setFeedback('Check your email to confirm your account, then sign in.')
      return
    }

    const { error } = await supabaseClient.auth.signInWithPassword({
      email: email.trim(),
      password,
      ...(captchaToken ? { options: { captchaToken } } : {}),
    })
    setBusy(false)
    if (captchaRequired) setCaptchaReset((n) => n + 1) // tokens are single-use
    if (error) setFeedback(error.message)
    else navigate('/dashboard', { replace: true })
  }

  async function signInWithGoogle() {
    if (!supabaseClient) {
      setFeedback(configurationError ?? 'Supabase is not configured.')
      return
    }
    setBusy(true)
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/dashboard` },
    })
    setBusy(false)
    if (error) setFeedback(error.message)
  }

  async function sendPasswordReset() {
    if (!supabaseClient) {
      setFeedback(configurationError ?? 'Supabase is not configured.')
      return
    }
    if (!email.trim()) {
      setFeedback('Enter your email address first.')
      return
    }
    setBusy(true)
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/login?recovery=1`,
    })
    setBusy(false)
    setFeedback(error ? error.message : 'If an account exists for that address, a reset link is on its way.')
  }

  if (isRecovery && isLoading) {
    return <div className="auth-page"><p className="auth-loading">Checking your recovery link...</p></div>
  }

  return <div className="auth-page"><Link to="/dashboard" className="brand auth-brand"><span className="brand-mark">c</span><span>clario</span></Link><div className="auth-card"><div className="auth-overline">A CLEARER WAY TO WORK</div><h1>{isRecovery ? 'Choose a new password.' : isSignup ? 'Make room for clarity.' : 'Welcome back.'}</h1><p>{isRecovery ? 'Update your password to secure your account.' : isSignup ? 'Create your account to get started.' : 'Sign in to return to your workspace.'}</p>{!isRecovery && <><button className="google-button" disabled={busy} onClick={() => void signInWithGoogle()}><span className="google-mark">G</span>Continue with Google</button><div className="auth-divider"><span />or continue with email<span /></div></>}<form onSubmit={(event) => void submit(event)} className="auth-form">{isSignup && <label>Full name<input required autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Your name" /></label>}{!isRecovery && <label>Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></label>}<label>{isRecovery ? 'New password' : 'Password'}<input required type="password" autoComplete={isRecovery || isSignup ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" minLength={8} /></label>{!isSignup && !isRecovery && <button type="button" className="forgot-button" disabled={busy} onClick={() => void sendPasswordReset()}>Forgot password?</button>}{captchaRequired && <Turnstile siteKey={turnstileSiteKey} onToken={setCaptchaToken} resetKey={captchaReset} />}{configurationError && <div className="auth-config-message" role="status">{configurationError} Add the values to <code>.env</code> and restart the dev server.</div>}{feedback && <div className="auth-feedback" role="status">{feedback}</div>}<button className="button button-dark button-wide" type="submit" disabled={busy || isLoading}>{busy ? 'Please wait...' : isRecovery ? 'Update password' : isSignup ? 'Create account' : 'Sign in'} {!busy && <ArrowRight size={16} />}</button></form>{!isRecovery && <p className="auth-switch">{isSignup ? 'Already have an account?' : 'New to Clario?'} <button onClick={() => navigate(isSignup ? '/login' : '/signup')}>{isSignup ? 'Sign in' : 'Create an account'}</button></p>}</div><div className="auth-foot"><LockKeyhole size={13} /> Private by design <span>·</span> Your files stay yours</div></div>
}

const UPLOAD_STAGE_COPY: Record<UploadStage, string> = {
  reading: 'Reading document in your browser...',
  uploading: 'Uploading to secure storage...',
  finishing: 'Verifying upload...',
  done: 'Done.',
}

function UploadDialog({ close, onUploaded }: { close: () => void; onUploaded: (document: DocumentSummary) => void }) {
  const [fileName, setFileName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [stage, setStage] = useState<UploadStage | null>(null)
  const busy = stage !== null && stage !== 'done'

  function acceptFile(file?: File) {
    if (!file) return
    const looksRight = /\.(pdf|docx)$/i.test(file.name) || file.type === 'application/pdf' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (!looksRight) { setError('Choose a PDF or DOCX file.'); setFileName(''); setSelectedFile(null); return }
    if (file.size > 25 * 1024 * 1024) { setError('This file is larger than 25 MB.'); setFileName(''); setSelectedFile(null); return }
    setError('')
    setFileName(file.name)
    setSelectedFile(file)
  }

  async function startUpload() {
    if (!selectedFile || busy) return
    setError('')
    try {
      const document = await uploadDocument(selectedFile, setStage)
      onUploaded(document)
      close()
    } catch (uploadError) {
      setStage(null)
      setError(uploadError instanceof FileValidationError || uploadError instanceof Error ? uploadError.message : 'Upload failed. Please try again.')
    }
  }

  return <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close() }}><motion.div className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }}><div className="modal-heading"><div><div className="eyebrow">ADD TO YOUR WORKSPACE</div><h2 id="upload-title">Bring a document in.</h2></div><button className="icon-button" aria-label="Close upload dialog" disabled={busy} onClick={close}><X size={18} /></button></div><label className={`upload-dropzone ${dragging ? 'drop-active' : ''}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) acceptFile(event.dataTransfer.files[0]) }}><input type="file" disabled={busy} accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => acceptFile(event.target.files?.[0])} /><span className="upload-symbol">{busy ? <Loader2 size={20} className="spin" /> : <FileUp size={20} />}</span><strong>{fileName || 'Drop your file here, or browse'}</strong><small>PDF or DOCX · Maximum file size 25 MB</small></label>{error && <div className="upload-error" role="alert">{error}</div>}<div className="upload-privacy"><ShieldCheck size={15} /><span>Files upload directly to private, encrypted storage — never through a third party.</span></div><div className="upload-preview-note">{stage && stage !== 'done' ? UPLOAD_STAGE_COPY[stage] : 'Text is extracted in your browser before anything uploads.'}</div><div className="modal-actions"><button className="button button-quiet" disabled={busy} onClick={close}>Cancel</button><button className="button button-dark" disabled={!fileName || busy} onClick={() => void startUpload()}>{busy ? 'Uploading...' : 'Upload'} {!busy && <Check size={15} />}</button></div></motion.div></motion.div>
}

export default App
