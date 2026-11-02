import { describe, expect, it } from 'vitest'
import { FILE_NAME_MAX_LENGTH, isNonEmptyString, kindForMimeType, sanitizeFileNameForKey } from '../validation'

describe('kindForMimeType', () => {
  it('recognizes the PDF mime type', () => {
    expect(kindForMimeType('application/pdf')).toBe('pdf')
  })

  it('recognizes the DOCX mime type', () => {
    expect(kindForMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx')
  })

  it('rejects an unsupported mime type', () => {
    expect(kindForMimeType('application/zip')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(kindForMimeType('')).toBeNull()
  })
})

describe('isNonEmptyString', () => {
  it('accepts a normal string within the limit', () => {
    expect(isNonEmptyString('hello', 10)).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isNonEmptyString('', 10)).toBe(false)
  })

  it('rejects a whitespace-only string', () => {
    expect(isNonEmptyString('   ', 10)).toBe(false)
  })

  it('rejects a string past the length limit', () => {
    expect(isNonEmptyString('a'.repeat(11), 10)).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isNonEmptyString(42, 10)).toBe(false)
    expect(isNonEmptyString(null, 10)).toBe(false)
    expect(isNonEmptyString(undefined, 10)).toBe(false)
  })
})

describe('sanitizeFileNameForKey', () => {
  it('keeps a simple safe file name as-is', () => {
    expect(sanitizeFileNameForKey('report.pdf')).toBe('report.pdf')
  })

  it('replaces spaces and unsafe characters', () => {
    expect(sanitizeFileNameForKey('Q3 Report (final)!.docx')).toBe('Q3_Report_final_.docx')
  })

  it('falls back to a default name when nothing safe remains', () => {
    expect(sanitizeFileNameForKey('???///')).toBe('document')
  })

  it('bounds extremely long file names', () => {
    const longName = `${'a'.repeat(400)}.pdf`
    const result = sanitizeFileNameForKey(longName)
    expect(result.length).toBeLessThanOrEqual(FILE_NAME_MAX_LENGTH)
  })
})
