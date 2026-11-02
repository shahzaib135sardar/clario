import { supabaseClient } from './supabase'
import { canRetryMethod, generateIdempotencyKey, isNetworkError, isRetryableStatus, withRetry } from './retry'

export type DocumentSummary = {
  id: string
  fileName: string
  fileType: string
  fileSize: number
  status: 'pending' | 'ready' | 'failed'
  createdAt: string
}

export type CreateDocumentResponse = {
  documentId: string
  uploadUrl: string
  storageKey: string
}

/** A problem the server reported, safe to show to the user as-is. */
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function getAccessToken(): Promise<string> {
  if (!supabaseClient) throw new ApiError('Not signed in.', 401)
  const { data } = await supabaseClient.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new ApiError('Your session has expired. Please sign in again.', 401)
  return token
}

const GET_TIMEOUT_MS = 30_000
const POST_TIMEOUT_MS = 90_000 // generation calls (AI + job boards) can legitimately take a while

/** One attempt: fetch with a deadline, then turn a non-2xx response into an ApiError. */
async function attempt<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(path, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError('The request took too long. Please try again.', 408)
    }
    throw error // a TypeError here means the network failed; the caller may retry
  } finally {
    clearTimeout(timer)
  }

  const isJson = response.headers.get('content-type')?.includes('application/json')
  const payload = isJson ? await response.json().catch(() => null) : null

  if (!response.ok) {
    const message = (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string')
      ? payload.error
      : `Something went wrong (${response.status}).`
    throw new ApiError(message, response.status)
  }

  return (payload ?? {}) as T
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken()
  const method = (init?.method ?? 'GET').toUpperCase()
  // One key per user action, reused by every retry of it, so the server can
  // recognise a repeat and return the first result instead of doing the work twice.
  const idempotencyKey = method === 'POST' ? generateIdempotencyKey() : null

  const requestInit: RequestInit = {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...init?.headers,
    },
  }
  const timeoutMs = method === 'GET' ? GET_TIMEOUT_MS : POST_TIMEOUT_MS
  const mayRetry = canRetryMethod(method, idempotencyKey !== null)

  return withRetry(
    () => attempt<T>(path, requestInit, timeoutMs),
    (error) => mayRetry && (error instanceof ApiError ? isRetryableStatus(error.status) : isNetworkError(error)),
  )
}

export function createDocument(input: {
  fileName: string
  fileType: string
  fileSize: number
  extractedText: string
}): Promise<CreateDocumentResponse> {
  return request<CreateDocumentResponse>('/api/documents', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function confirmDocumentUpload(documentId: string): Promise<{ document: DocumentSummary }> {
  return request<{ document: DocumentSummary }>(`/api/documents/${documentId}/confirm`, {
    method: 'POST',
  })
}

export function listDocuments(): Promise<{ documents: DocumentSummary[] }> {
  return request<{ documents: DocumentSummary[] }>('/api/documents')
}

export function getDocument(documentId: string): Promise<{ document: DocumentSummary }> {
  return request<{ document: DocumentSummary }>(`/api/documents/${documentId}`)
}

export function deleteDocument(documentId: string): Promise<{ success: true }> {
  return request<{ success: true }>(`/api/documents/${documentId}`, { method: 'DELETE' })
}

export type UsageCounts = { documents: number; conversations: number; artifacts: number }

export function getUsage(): Promise<UsageCounts> {
  return request<UsageCounts>('/api/usage')
}

// --- Chat (Milestone 4) -----------------------------------------------

export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; created_at: string }

export function listChatMessages(documentId: string): Promise<{ messages: ChatMessage[] }> {
  return request<{ messages: ChatMessage[] }>(`/api/documents/${documentId}/chat`)
}

export function sendChatMessage(
  documentId: string,
  message: string,
): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage | null; error?: string }> {
  return request(`/api/documents/${documentId}/chat`, { method: 'POST', body: JSON.stringify({ message }) })
}

// --- Generated artifacts (Milestone 5) ----------------------------------

export type SummaryContent = { headline: string; lede: string; points: { title: string; body: string }[] }
export type ChartContent = {
  title: string
  lede: string
  totalLabel: string
  totalValue: string
  sourceNote: string
  series: { label: string; value: number }[]
}
export type PlanContent = {
  title: string
  lede: string
  tasks: { task: string; note: string; estimatedMinutes: number }[]
}

export type Artifact<T> = { id: string; content: T; createdAt: string }

export function getSummary(documentId: string): Promise<{ summary: Artifact<SummaryContent> | null }> {
  return request(`/api/documents/${documentId}/summary`)
}
export function generateSummary(documentId: string): Promise<{ summary: Artifact<SummaryContent> }> {
  return request(`/api/documents/${documentId}/summary`, { method: 'POST' })
}

export function getChart(documentId: string): Promise<{ chart: Artifact<ChartContent> | null }> {
  return request(`/api/documents/${documentId}/chart`)
}
export function generateChart(documentId: string): Promise<{ chart: Artifact<ChartContent> }> {
  return request(`/api/documents/${documentId}/chart`, { method: 'POST' })
}

export function getPlan(documentId: string): Promise<{ plan: Artifact<PlanContent> | null }> {
  return request(`/api/documents/${documentId}/plan`)
}
export function generatePlan(documentId: string): Promise<{ plan: Artifact<PlanContent> }> {
  return request(`/api/documents/${documentId}/plan`, { method: 'POST' })
}

// --- Presentation export (Milestone 6) ----------------------------------

export type PresentationContent = { deckTitle: string; deckSubtitle: string; slideCount: number }
export type Presentation = { id: string; content: PresentationContent; createdAt: string; downloadUrl: string }

export function getPresentation(documentId: string): Promise<{ presentation: Presentation | null }> {
  return request(`/api/documents/${documentId}/pptx`)
}
export function generatePresentation(documentId: string): Promise<{ presentation: Presentation }> {
  return request(`/api/documents/${documentId}/pptx`, { method: 'POST' })
}

// --- Resume analyzer -----------------------------------------------------

export type ResumeAnalysisContent = {
  jobDescription: string
  matchScore: number
  summary: string
  strengths: string[]
  gaps: string[]
  missingKeywords: string[]
  suggestions: string[]
}

// --- Job suggestions -----------------------------------------------------

export type JobMatch = {
  id: string
  source: 'remotive' | 'arbeitnow' | 'remoteok'
  title: string
  company: string
  location: string
  remote: boolean
  url: string
  tags: string[]
  postedAt: string | null
  salary: string | null
  snippet: string
  score: number
  matchedSkills: string[]
}

export type JobMatchesContent = {
  profile: { titles: string[]; skills: string[]; level: string }
  jobs: JobMatch[]
  sources: { id: JobMatch['source']; label: string; status: 'fresh' | 'cached' | 'stale' | 'unavailable'; count: number }[]
  generatedAt: string
}

export function getJobMatches(documentId: string): Promise<{ matches: Artifact<JobMatchesContent> | null }> {
  return request(`/api/documents/${documentId}/jobs`)
}
export function refreshJobMatches(documentId: string): Promise<{ matches: Artifact<JobMatchesContent> }> {
  return request(`/api/documents/${documentId}/jobs`, { method: 'POST' })
}

export function getResumeAnalysis(documentId: string): Promise<{ analysis: Artifact<ResumeAnalysisContent> | null }> {
  return request(`/api/documents/${documentId}/resume-analysis`)
}
export function generateResumeAnalysis(
  documentId: string,
  jobDescription: string,
): Promise<{ analysis: Artifact<ResumeAnalysisContent> }> {
  return request(`/api/documents/${documentId}/resume-analysis`, {
    method: 'POST',
    body: JSON.stringify({ jobDescription }),
  })
}
