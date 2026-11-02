import { describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES, isWithinSizeLimit, sniffFileKind } from '../fileRules'

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('sniffFileKind', () => {
  it('recognizes a PDF signature', () => {
    expect(sniffFileKind(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37))).toBe('pdf')
  })

  it('recognizes a zip-based (docx) signature', () => {
    expect(sniffFileKind(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0))).toBe('docx')
  })

  it('rejects unrelated bytes', () => {
    expect(sniffFileKind(bytes(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07))).toBeNull()
  })

  it('rejects a plain-text file masquerading with a .pdf-like name', () => {
    const text = new TextEncoder().encode('Hello, this is not a PDF')
    expect(sniffFileKind(text)).toBeNull()
  })

  it('rejects a buffer too short to contain any known signature', () => {
    expect(sniffFileKind(bytes(0x25, 0x50))).toBeNull()
  })
})

describe('isWithinSizeLimit', () => {
  it('rejects empty files', () => {
    expect(isWithinSizeLimit(0)).toBe(false)
  })

  it('accepts a single byte', () => {
    expect(isWithinSizeLimit(1)).toBe(true)
  })

  it('accepts exactly the maximum size', () => {
    expect(isWithinSizeLimit(MAX_FILE_BYTES)).toBe(true)
  })

  it('rejects one byte over the maximum size', () => {
    expect(isWithinSizeLimit(MAX_FILE_BYTES + 1)).toBe(false)
  })

  it('rejects negative sizes', () => {
    expect(isWithinSizeLimit(-1)).toBe(false)
  })
})
