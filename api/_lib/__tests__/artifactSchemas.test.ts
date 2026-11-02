import { describe, expect, it } from 'vitest'
import {
  ArtifactShapeError,
  validateChartContent,
  validatePlanContent,
  validateResumeAnalysisContent,
  validateSlideOutline,
  validateSummaryContent,
} from '../artifactSchemas'

describe('validateSummaryContent', () => {
  it('accepts a well-formed summary', () => {
    const input = {
      headline: 'Growth ahead',
      lede: 'Some context.',
      points: [{ title: 'Renewals', body: 'Holding steady.' }],
    }
    expect(validateSummaryContent(input)).toEqual(input)
  })

  it('rejects a missing headline', () => {
    expect(() => validateSummaryContent({ lede: 'x', points: [{ title: 'a', body: 'b' }] })).toThrow(ArtifactShapeError)
  })

  it('rejects an empty points array', () => {
    expect(() => validateSummaryContent({ headline: 'x', lede: 'y', points: [] })).toThrow(ArtifactShapeError)
  })

  it('rejects a malformed point', () => {
    expect(() => validateSummaryContent({ headline: 'x', lede: 'y', points: [{ title: 'only title' }] })).toThrow(
      ArtifactShapeError,
    )
  })

  it('rejects a non-object value', () => {
    expect(() => validateSummaryContent('not an object')).toThrow(ArtifactShapeError)
    expect(() => validateSummaryContent(null)).toThrow(ArtifactShapeError)
  })
})

describe('validateChartContent', () => {
  it('accepts a well-formed chart and defaults optional fields', () => {
    const result = validateChartContent({
      title: 'Revenue mix',
      lede: 'A quarterly breakdown.',
      series: [{ label: 'Recurring', value: 76 }],
    })
    expect(result.series).toEqual([{ label: 'Recurring', value: 76 }])
    expect(result.totalLabel).toBe('Total')
    expect(result.totalValue).toBe('')
  })

  it('rejects a negative series value', () => {
    expect(() =>
      validateChartContent({ title: 'x', lede: 'y', series: [{ label: 'a', value: -1 }] }),
    ).toThrow(ArtifactShapeError)
  })

  it('rejects a non-numeric series value', () => {
    expect(() =>
      validateChartContent({ title: 'x', lede: 'y', series: [{ label: 'a', value: '76' }] }),
    ).toThrow(ArtifactShapeError)
  })

  it('rejects an empty series array', () => {
    expect(() => validateChartContent({ title: 'x', lede: 'y', series: [] })).toThrow(ArtifactShapeError)
  })
})

describe('validatePlanContent', () => {
  it('defaults a missing estimatedMinutes to 30', () => {
    const result = validatePlanContent({ title: 'x', lede: 'y', tasks: [{ task: 'Do the thing' }] })
    expect(result.tasks[0].estimatedMinutes).toBe(30)
  })

  it('clamps a tiny estimatedMinutes up to 5', () => {
    const result = validatePlanContent({ title: 'x', lede: 'y', tasks: [{ task: 'Do it', estimatedMinutes: 0 }] })
    expect(result.tasks[0].estimatedMinutes).toBe(5)
  })

  it('rejects an empty tasks array', () => {
    expect(() => validatePlanContent({ title: 'x', lede: 'y', tasks: [] })).toThrow(ArtifactShapeError)
  })
})

describe('validateSlideOutline', () => {
  it('accepts a well-formed outline', () => {
    const result = validateSlideOutline({
      deckTitle: 'Q3 review',
      slides: [{ title: 'Overview', bullets: ['One', 'Two'] }],
    })
    expect(result.slides).toHaveLength(1)
    expect(result.slides[0].bullets).toEqual(['One', 'Two'])
  })

  it('rejects a slide missing bullets', () => {
    expect(() => validateSlideOutline({ deckTitle: 'x', slides: [{ title: 'Overview' }] })).toThrow(ArtifactShapeError)
  })

  it('rejects an empty slides array', () => {
    expect(() => validateSlideOutline({ deckTitle: 'x', slides: [] })).toThrow(ArtifactShapeError)
  })
})

describe('validateResumeAnalysisContent', () => {
  it('clamps an out-of-range matchScore into 0-100', () => {
    expect(validateResumeAnalysisContent({ matchScore: 140, summary: 'x' }).matchScore).toBe(100)
    expect(validateResumeAnalysisContent({ matchScore: -20, summary: 'x' }).matchScore).toBe(0)
  })

  it('defaults missing array fields to empty arrays', () => {
    const result = validateResumeAnalysisContent({ matchScore: 70, summary: 'Solid fit.' })
    expect(result.strengths).toEqual([])
    expect(result.gaps).toEqual([])
    expect(result.missingKeywords).toEqual([])
    expect(result.suggestions).toEqual([])
  })

  it('rejects a missing summary', () => {
    expect(() => validateResumeAnalysisContent({ matchScore: 70 })).toThrow(ArtifactShapeError)
  })
})
