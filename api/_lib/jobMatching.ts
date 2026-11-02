import type { JobProfile } from './artifactSchemas'
import type { FeedJob, JobSourceId } from './jobSources'

// Ranks cached job listings against what the AI model read from a resume.
// Deliberately plain keyword scoring, not another model call: it is fast,
// free, explainable ("matched on React, TypeScript"), and the listings never
// leave this server.

export type JobMatch = {
  id: string
  source: JobSourceId
  title: string
  company: string
  location: string
  remote: boolean
  url: string
  tags: string[]
  postedAt: string | null
  salary: string | null
  snippet: string
  /** 0–100 relevance to the resume. Not the resume-analyzer match score. */
  score: number
  matchedSkills: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_SCORE = 25
const SNIPPET_CHARS = 200
const STOPWORDS = new Set(['and', 'or', 'the', 'of', 'for', 'a', 'an', 'in', 'at', 'to', 'with', 'sr', 'jr', 'i', 'ii', 'iii'])
const SENIOR_TITLE = /\b(senior|sr|staff|principal|lead|head|director|vp|manager|architect)\b/i
const JUNIOR_TITLE = /\b(intern|internship|junior|jr|trainee|graduate|entry[- ]level|apprentice)\b/i

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#.]+/g) ?? [])
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-term match that also works for "c++", "c#", ".net" and "node.js". */
export function containsTerm(haystack: string, term: string): boolean {
  const needle = term.trim().toLowerCase()
  if (!needle) return false
  return new RegExp(`(^|[^a-z0-9+#])${escapeRegExp(needle)}($|[^a-z0-9+#])`).test(haystack.toLowerCase())
}

function titleScore(jobTitle: string, profileTitles: string[]): number {
  const jobTokens = new Set(tokens(jobTitle))
  let best = 0
  for (const wanted of profileTitles) {
    const wantedTokens = tokens(wanted)
    if (wantedTokens.length === 0) continue
    const hits = wantedTokens.filter((token) => jobTokens.has(token)).length
    let ratio = hits / wantedTokens.length
    if (containsTerm(jobTitle, wanted)) ratio = 1
    // One shared word out of several ("Engineer") is a weak signal.
    else if (hits < 2 && ratio < 1) ratio *= 0.5
    best = Math.max(best, ratio)
  }
  return best
}

function recencyScore(postedAt: string | null, now: number): number {
  if (!postedAt) return 3
  const days = (now - Date.parse(postedAt)) / DAY_MS
  if (!Number.isFinite(days)) return 3
  if (days <= 3) return 10
  if (days <= 14) return 7
  if (days <= 30) return 4
  return 0
}

function levelAdjustment(title: string, level: JobProfile['level']): number {
  if ((level === 'intern' || level === 'junior') && SENIOR_TITLE.test(title)) return -20
  if ((level === 'senior' || level === 'lead') && JUNIOR_TITLE.test(title)) return -20
  return 0
}

export function makeSnippet(text: string): string {
  if (text.length <= SNIPPET_CHARS) return text
  const cut = text.slice(0, SNIPPET_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

export function rankJobs(jobs: FeedJob[], profile: JobProfile, now = Date.now(), limit = 30): JobMatch[] {
  const matches: JobMatch[] = []

  for (const job of jobs) {
    const tagText = job.tags.join(' ')
    let skillWeight = 0
    const matchedSkills: string[] = []

    for (const skill of profile.skills) {
      const inHeadline = containsTerm(`${job.title} ${tagText}`, skill)
      // Very short names ("c", "go", "r") only count when the job itself lists them.
      const inText = skill.trim().length > 2 && containsTerm(job.text, skill)
      if (!inHeadline && !inText) continue
      skillWeight += inHeadline ? 1.5 : 1
      matchedSkills.push(skill)
    }

    const titlePart = 45 * titleScore(job.title, profile.titles)
    const skillPart = 45 * Math.min(1, skillWeight / 6)
    const score = Math.round(titlePart + skillPart + recencyScore(job.postedAt, now) + levelAdjustment(job.title, profile.level))

    if (score < MIN_SCORE || (titlePart === 0 && matchedSkills.length < 2)) continue

    matches.push({
      id: job.id,
      source: job.source,
      title: job.title,
      company: job.company,
      location: job.location,
      remote: job.remote,
      url: job.url,
      tags: job.tags,
      postedAt: job.postedAt,
      salary: job.salary,
      snippet: makeSnippet(job.text),
      score: Math.min(100, score),
      matchedSkills: matchedSkills.slice(0, 6),
    })
  }

  return matches
    .sort((a, b) => b.score - a.score || (b.postedAt ?? '').localeCompare(a.postedAt ?? ''))
    .slice(0, limit)
}
