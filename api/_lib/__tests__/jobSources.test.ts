import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the tests off the network and off Redis: the cache falls back to memory.
vi.mock('../rateLimit', () => ({
  getRedis: () => {
    throw new Error('redis not configured in tests')
  },
}))

import {
  clearJobMemoryCache,
  htmlToText,
  loadFeed,
  parseArbeitnow,
  parseRemoteOk,
  parseRemotive,
  safeJobUrl,
  type FeedJob,
} from '../jobSources'

beforeEach(() => {
  clearJobMemoryCache()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('htmlToText', () => {
  it('strips tags, scripts and entities', () => {
    expect(htmlToText('<p>Build <b>APIs</b> &amp; tools</p><script>alert(1)</script><style>p{}</style>&nbsp;Now')).toBe(
      'Build APIs & tools Now',
    )
  })
  it('decodes numeric entities and ignores bad ones', () => {
    expect(htmlToText('&#8217;s &#x41; &#9999999999;')).toBe('’s A')
  })
  it('returns an empty string for non-strings', () => {
    expect(htmlToText(undefined)).toBe('')
  })
})

describe('safeJobUrl', () => {
  const hosts = ['remotive.com']
  it('accepts https links on the board', () => {
    expect(safeJobUrl('https://remotive.com/remote-jobs/x', hosts)).toBe('https://remotive.com/remote-jobs/x')
    expect(safeJobUrl('https://www.remotive.com/a', hosts)).not.toBeNull()
  })
  it('rejects other hosts, look-alikes, and non-https schemes', () => {
    expect(safeJobUrl('https://evil.example/remotive.com', hosts)).toBeNull()
    expect(safeJobUrl('https://remotive.com.evil.example/a', hosts)).toBeNull()
    expect(safeJobUrl('http://remotive.com/a', hosts)).toBeNull()
    expect(safeJobUrl('javascript:alert(1)', hosts)).toBeNull()
    expect(safeJobUrl(42, hosts)).toBeNull()
  })
})

describe('parseRemotive', () => {
  const payload = {
    'job-count': 2,
    jobs: [
      {
        id: 101,
        url: 'https://remotive.com/remote-jobs/software-dev/react-dev-101',
        title: 'React Developer',
        company_name: 'Acme',
        category: 'Software Development',
        tags: ['react', 'typescript'],
        job_type: 'full_time',
        publication_date: '2026-10-20T09:30:00',
        candidate_required_location: 'Worldwide',
        salary: '$60k-$80k',
        description: '<p>Build <b>UI</b></p>',
      },
      { id: 102, url: 'https://elsewhere.example/job', title: 'Bad link', company_name: 'X' },
    ],
  }

  it('normalizes listings and drops ones with foreign links', () => {
    const jobs = parseRemotive(payload)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      id: 'remotive:101',
      source: 'remotive',
      title: 'React Developer',
      company: 'Acme',
      location: 'Worldwide',
      remote: true,
      salary: '$60k-$80k',
      postedAt: '2026-10-20T09:30:00.000Z',
      text: 'Build UI',
    })
    expect(jobs[0].tags).toEqual(['react', 'typescript', 'Software Development', 'full time'])
  })

  it('throws on an unexpected shape', () => {
    expect(() => parseRemotive({ nope: true })).toThrow()
  })
})

describe('parseArbeitnow', () => {
  it('reads unix timestamps and the remote flag', () => {
    const jobs = parseArbeitnow({
      data: [
        {
          slug: 'dev-berlin-1',
          company_name: 'Zed',
          title: 'Backend Developer',
          description: '<p>Node.js</p>',
          remote: false,
          url: 'https://www.arbeitnow.com/jobs/companies/zed/dev-berlin-1',
          tags: ['Engineering'],
          job_types: [],
          location: 'Berlin',
          created_at: 1792734914,
        },
      ],
    })
    expect(jobs[0]).toMatchObject({ id: 'arbeitnow:dev-berlin-1', remote: false, location: 'Berlin', text: 'Node.js' })
    expect(jobs[0].postedAt).toBe(new Date(1792734914 * 1000).toISOString())
  })
})

describe('parseRemoteOk', () => {
  it('skips the legal notice and builds a salary range', () => {
    const jobs = parseRemoteOk([
      { legal: 'API Terms of Service: link back to the URL on Remote OK' },
      {
        id: '55',
        epoch: 1792734914,
        position: 'Python Engineer',
        company: 'Orbit',
        tags: ['python', 'django'],
        location: '',
        salary_min: 90000,
        salary_max: 120000,
        url: 'https://remoteOK.com/remote-jobs/python-engineer-orbit-55',
        description: 'Python <i>work</i>',
      },
    ])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ id: 'remoteok:55', location: 'Remote', salary: '$90,000–$120,000' })
    expect(jobs[0].url).toBe('https://remoteok.com/remote-jobs/python-engineer-orbit-55')
  })
})

describe('loadFeed caching', () => {
  const job: FeedJob = {
    id: 'remotive:1',
    source: 'remotive',
    title: 'Dev',
    company: 'A',
    location: 'Worldwide',
    remote: true,
    url: 'https://remotive.com/x',
    tags: [],
    postedAt: null,
    salary: null,
    text: '',
  }

  it('downloads once, then serves the cached copy while fresh', async () => {
    const fetcher = vi.fn().mockResolvedValue([job])
    const first = await loadFeed('remotive', { now: 1_000, fetcher })
    const second = await loadFeed('remotive', { now: 1_000 + 60_000, fetcher })
    expect(first.status).toBe('fresh')
    expect(second.status).toBe('cached')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('falls back to the last good copy when the board is down', async () => {
    await loadFeed('remotive', { now: 0, fetcher: async () => [job] })
    const later = 9 * 60 * 60 * 1000
    const result = await loadFeed('remotive', {
      now: later,
      fetcher: async () => {
        throw new Error('down')
      },
    })
    expect(result.status).toBe('stale')
    expect(result.jobs).toEqual([job])
  })

  it('reports unavailable when there is nothing cached and the board is down', async () => {
    const result = await loadFeed('remoteok', {
      fetcher: async () => {
        throw new Error('down')
      },
    })
    expect(result).toEqual({ source: 'remoteok', status: 'unavailable', jobs: [] })
  })
})
