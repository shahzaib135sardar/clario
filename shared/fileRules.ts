// Rules shared between the browser (src/) and the serverless API (api/).
// Keeping these in one place means the client and the server can never
// quietly drift apart on what counts as a valid upload.

export const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB

export const SUPPORTED_MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const

export type SupportedFileKind = keyof typeof SUPPORTED_MIME_TYPES

// Magic-byte signatures, checked against the start of the actual file
// contents — never trust a browser-reported File.type or a filename
// extension, both of which are trivial for a caller to fake.
const PDF_SIGNATURE: readonly number[] = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"

// .docx is a zip (OOXML) container. A standard, non-empty zip starts with
// the "local file header" signature below. This only proves the bytes are
// a zip — callers must still confirm it actually parses as a Word document
// (see extractDocumentText on the client, and the server-side re-check).
const ZIP_SIGNATURE: readonly number[] = [0x50, 0x4b, 0x03, 0x04] // "PK\x03\x04"

export const SIGNATURE_PREFIX_BYTES = 8

function matchesSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false
  }
  return true
}

/**
 * Identifies a file's real kind from its leading bytes. Returns null when
 * the bytes don't match any supported format, regardless of what the
 * filename or declared content type claim.
 */
export function sniffFileKind(bytes: Uint8Array): SupportedFileKind | null {
  if (matchesSignature(bytes, PDF_SIGNATURE)) return 'pdf'
  if (matchesSignature(bytes, ZIP_SIGNATURE)) return 'docx'
  return null
}

export function isWithinSizeLimit(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= MAX_FILE_BYTES
}

export const MAX_EXTRACTED_CHARACTERS = 200_000
