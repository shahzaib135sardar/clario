// Validates the shape of parsed JSON coming back from an AI provider before
// it's ever persisted or sent to the browser. A model asked for strict JSON
// can still return a field with the wrong type or an empty array — these
// checks are the actual trust boundary, not the prompt wording.

export class ArtifactShapeError extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function asTrimmedStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(isNonEmptyString).slice(0, max).map((entry) => entry.trim())
}

export type SummaryPoint = { title: string; body: string }
export type SummaryContent = { headline: string; lede: string; points: SummaryPoint[] }

export function validateSummaryContent(value: unknown): SummaryContent {
  const v = value as Partial<SummaryContent> | null
  if (!v || !isNonEmptyString(v.headline) || !isNonEmptyString(v.lede) || !Array.isArray(v.points)) {
    throw new ArtifactShapeError('Summary response was missing required fields.')
  }
  const points = v.points.slice(0, 6).map((point) => {
    const p = point as Partial<SummaryPoint> | null
    if (!p || !isNonEmptyString(p.title) || !isNonEmptyString(p.body)) {
      throw new ArtifactShapeError('Summary response had a malformed point.')
    }
    return { title: p.title.trim(), body: p.body.trim() }
  })
  if (points.length === 0) throw new ArtifactShapeError('Summary response had no points.')
  return { headline: v.headline.trim(), lede: v.lede.trim(), points }
}

export type ChartSeriesPoint = { label: string; value: number }
export type ChartContent = {
  title: string
  lede: string
  totalLabel: string
  totalValue: string
  sourceNote: string
  series: ChartSeriesPoint[]
}

export function validateChartContent(value: unknown): ChartContent {
  const v = value as Partial<ChartContent> | null
  if (!v || !isNonEmptyString(v.title) || !isNonEmptyString(v.lede) || !Array.isArray(v.series)) {
    throw new ArtifactShapeError('Chart response was missing required fields.')
  }
  const series = v.series.slice(0, 8).map((entry) => {
    const e = entry as Partial<ChartSeriesPoint> | null
    if (!e || !isNonEmptyString(e.label) || !isFiniteNumber(e.value) || e.value < 0) {
      throw new ArtifactShapeError('Chart response had a malformed series entry.')
    }
    return { label: e.label.trim(), value: e.value }
  })
  if (series.length === 0) throw new ArtifactShapeError('Chart response had no series data.')
  return {
    title: v.title.trim(),
    lede: v.lede.trim(),
    totalLabel: isNonEmptyString(v.totalLabel) ? v.totalLabel.trim() : 'Total',
    totalValue: isNonEmptyString(v.totalValue) ? v.totalValue.trim() : '',
    sourceNote: isNonEmptyString(v.sourceNote) ? v.sourceNote.trim() : '',
    series,
  }
}

export type PlanTask = { task: string; note: string; estimatedMinutes: number }
export type PlanContent = { title: string; lede: string; tasks: PlanTask[] }

export function validatePlanContent(value: unknown): PlanContent {
  const v = value as Partial<PlanContent> | null
  if (!v || !isNonEmptyString(v.title) || !isNonEmptyString(v.lede) || !Array.isArray(v.tasks)) {
    throw new ArtifactShapeError('Plan response was missing required fields.')
  }
  const tasks = v.tasks.slice(0, 8).map((entry) => {
    const e = entry as Partial<PlanTask> | null
    if (!e || !isNonEmptyString(e.task)) {
      throw new ArtifactShapeError('Plan response had a malformed task.')
    }
    return {
      task: e.task.trim(),
      note: isNonEmptyString(e.note) ? e.note.trim() : '',
      estimatedMinutes: isFiniteNumber(e.estimatedMinutes) ? Math.max(5, Math.round(e.estimatedMinutes)) : 30,
    }
  })
  if (tasks.length === 0) throw new ArtifactShapeError('Plan response had no tasks.')
  return { title: v.title.trim(), lede: v.lede.trim(), tasks }
}

export type SlideOutlineSlide = { kicker: string; title: string; bullets: string[]; notes: string }
export type SlideOutline = { deckTitle: string; deckSubtitle: string; slides: SlideOutlineSlide[] }

export function validateSlideOutline(value: unknown): SlideOutline {
  const v = value as Partial<SlideOutline> | null
  if (!v || !isNonEmptyString(v.deckTitle) || !Array.isArray(v.slides)) {
    throw new ArtifactShapeError('Presentation outline was missing required fields.')
  }
  const slides = v.slides.slice(0, 10).map((entry) => {
    const e = entry as Partial<SlideOutlineSlide> | null
    if (!e || !isNonEmptyString(e.title) || !Array.isArray(e.bullets)) {
      throw new ArtifactShapeError('Presentation outline had a malformed slide.')
    }
    return {
      kicker: isNonEmptyString(e.kicker) ? e.kicker.trim() : '',
      title: e.title.trim(),
      bullets: asTrimmedStringArray(e.bullets, 6),
      notes: isNonEmptyString(e.notes) ? e.notes.trim() : '',
    }
  })
  if (slides.length === 0) throw new ArtifactShapeError('Presentation outline had no slides.')
  return {
    deckTitle: v.deckTitle.trim(),
    deckSubtitle: isNonEmptyString(v.deckSubtitle) ? v.deckSubtitle.trim() : '',
    slides,
  }
}

export type JobLevel = 'intern' | 'junior' | 'mid' | 'senior' | 'lead'
export type JobProfile = { titles: string[]; skills: string[]; level: JobLevel }

const JOB_LEVELS: readonly JobLevel[] = ['intern', 'junior', 'mid', 'senior', 'lead']

/** What to search job boards for, as extracted from a resume by the AI model. */
export function validateJobProfile(value: unknown): JobProfile {
  const v = value as { titles?: unknown; skills?: unknown; level?: unknown } | null
  if (!v || typeof v !== 'object') {
    throw new ArtifactShapeError('Job profile response was missing required fields.')
  }
  const titles = asTrimmedStringArray(v.titles, 5).filter((entry) => entry.length <= 80)
  const skills = asTrimmedStringArray(v.skills, 15).filter((entry) => entry.length <= 40)
  if (titles.length === 0 && skills.length < 3) {
    throw new ArtifactShapeError('Job profile had too little to search with.')
  }
  const level = typeof v.level === 'string' ? (v.level.trim().toLowerCase() as JobLevel) : 'mid'
  return { titles, skills, level: JOB_LEVELS.includes(level) ? level : 'mid' }
}

export type ResumeAnalysisContent = {
  matchScore: number
  summary: string
  strengths: string[]
  gaps: string[]
  missingKeywords: string[]
  suggestions: string[]
}

export function validateResumeAnalysisContent(value: unknown): ResumeAnalysisContent {
  const v = value as Partial<ResumeAnalysisContent> | null
  if (!v || !isFiniteNumber(v.matchScore) || !isNonEmptyString(v.summary)) {
    throw new ArtifactShapeError('Resume analysis response was missing required fields.')
  }
  return {
    matchScore: Math.min(100, Math.max(0, Math.round(v.matchScore))),
    summary: v.summary.trim(),
    strengths: asTrimmedStringArray(v.strengths, 8),
    gaps: asTrimmedStringArray(v.gaps, 8),
    missingKeywords: asTrimmedStringArray(v.missingKeywords, 12),
    suggestions: asTrimmedStringArray(v.suggestions, 8),
  }
}
