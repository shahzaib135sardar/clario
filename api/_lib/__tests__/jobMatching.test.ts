import { describe, expect, it } from 'vitest'
import { containsTerm, rankJobs, makeSnippet } from '../jobMatching'
import { validateJobProfile, ArtifactShapeError, type JobProfile } from '../artifactSchemas'
import type { FeedJob } from '../jobSources'

const NOW = Date.parse('2026-10-24T00:00:00Z')

function job(overrides: Partial<FeedJob>): FeedJob {
  return {
    id: overrides.id ?? 'remotive:1',
    source: 'remotive',
    title: 'Software Engineer',
    company: 'Acme',
    location: 'Worldwide',
    remote: true,
    url: 'https://remotive.com/x',
    tags: [],
    postedAt: '2026-10-22T00:00:00.000Z',
    salary: null,
    text: '',
    ...overrides,
  }
}

const profile: JobProfile = {
  titles: ['Software Engineer', 'Machine Learning Engineer'],
  skills: ['Python', 'React', 'TypeScript', 'C++'],
  level: 'junior',
}

describe('containsTerm', () => {
  it('matches whole terms only', () => {
    expect(containsTerm('We use React and Node.js.', 'react')).toBe(true)
    expect(containsTerm('reactive programming', 'react')).toBe(false)
    expect(containsTerm('Strong C++ skills', 'c++')).toBe(true)
    expect(containsTerm('Experience with .NET', '.net')).toBe(true)
    expect(containsTerm('anything', '')).toBe(false)
  })
})

describe('rankJobs', () => {
  it('puts a title and skill match above a weak one, and explains why', () => {
    const ranked = rankJobs(
      [
        job({ id: 'a', title: 'Mechanical Engineer', text: 'CAD and machining' }),
        job({ id: 'b', title: 'Software Engineer', tags: ['python', 'react'], text: 'Build with TypeScript' }),
      ],
      profile,
      NOW,
    )
    expect(ranked.map((match) => match.id)).toEqual(['b'])
    expect(ranked[0].matchedSkills).toEqual(['Python', 'React', 'TypeScript'])
    expect(ranked[0].score).toBeGreaterThan(60)
  })

  it('keeps unrelated jobs out entirely', () => {
    expect(rankJobs([job({ title: 'Sales Manager', text: 'Close deals' })], profile, NOW)).toEqual([])
  })

  it('needs two skills when the title says nothing', () => {
    const oneSkill = job({ id: 'x', title: 'Platform Wizard', tags: ['python'] })
    const twoSkills = job({ id: 'y', title: 'Platform Wizard', tags: ['python', 'react', 'typescript'] })
    expect(rankJobs([oneSkill, twoSkills], profile, NOW).map((match) => match.id)).toEqual(['y'])
  })

  it('pushes senior roles down for a junior candidate', () => {
    const ranked = rankJobs(
      [
        job({ id: 'senior', title: 'Senior Software Engineer', tags: ['python', 'react'] }),
        job({ id: 'junior', title: 'Junior Software Engineer', tags: ['python', 'react'] }),
      ],
      profile,
      NOW,
    )
    expect(ranked[0].id).toBe('junior')
  })

  it('prefers newer listings when everything else is equal', () => {
    const ranked = rankJobs(
      [
        job({ id: 'old', tags: ['python', 'react'], postedAt: '2026-08-01T00:00:00.000Z' }),
        job({ id: 'new', tags: ['python', 'react'], postedAt: '2026-10-23T00:00:00.000Z' }),
      ],
      profile,
      NOW,
    )
    expect(ranked.map((match) => match.id)).toEqual(['new', 'old'])
  })

  it('never returns the matching text, only a short snippet, and respects the limit', () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      job({ id: `j${index}`, tags: ['python', 'react'], text: 'word '.repeat(200) }),
    )
    const ranked = rankJobs(many, profile, NOW, 10)
    expect(ranked).toHaveLength(10)
    expect('text' in ranked[0]).toBe(false)
    expect(ranked[0].snippet.length).toBeLessThanOrEqual(201)
  })
})

describe('makeSnippet', () => {
  it('cuts long text at a word boundary', () => {
    const snippet = makeSnippet('lorem '.repeat(100))
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(201)
  })
})

describe('validateJobProfile', () => {
  it('accepts a good profile and normalizes the level', () => {
    expect(validateJobProfile({ titles: ['Software Engineer'], skills: ['Python'], level: 'Junior' })).toEqual({
      titles: ['Software Engineer'],
      skills: ['Python'],
      level: 'junior',
    })
  })
  it('falls back to mid for an unknown level', () => {
    expect(validateJobProfile({ titles: ['Dev'], skills: [], level: 'wizard' }).level).toBe('mid')
  })
  it('rejects a profile with nothing to search on', () => {
    expect(() => validateJobProfile({ titles: [], skills: ['a', 'b'], level: 'mid' })).toThrow(ArtifactShapeError)
    expect(() => validateJobProfile(null)).toThrow(ArtifactShapeError)
  })
})
