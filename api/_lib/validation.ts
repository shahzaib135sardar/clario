import {
  MAX_EXTRACTED_CHARACTERS,
  MAX_FILE_BYTES,
  SUPPORTED_MIME_TYPES,
  isWithinSizeLimit,
  sniffFileKind,
  type SupportedFileKind,
} from '../../shared/fileRules'

export { MAX_FILE_BYTES, MAX_EXTRACTED_CHARACTERS, isWithinSizeLimit, sniffFileKind }

const MIME_TO_KIND: Record<string, SupportedFileKind> = Object.fromEntries(
  Object.entries(SUPPORTED_MIME_TYPES).map(([kind, mime]) => [mime, kind as SupportedFileKind]),
)

export function kindForMimeType(mimeType: string): SupportedFileKind | null {
  return MIME_TO_KIND[mimeType] ?? null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Ids come straight from the URL; reject anything that is not a UUID before it reaches a query. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

const FILE_NAME_MAX_LENGTH = 180

/** Keeps a user-supplied file name safe to embed in a storage object key. */
export function sanitizeFileNameForKey(fileName: string): string {
  const trimmed = fileName.trim().slice(-FILE_NAME_MAX_LENGTH)
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_')
  // A run of only unsafe characters (e.g. "???///") still sanitizes to a
  // non-empty string of underscores — check for an actual alphanumeric
  // character, not just non-emptiness, before accepting it.
  return /[a-zA-Z0-9]/.test(safe) ? safe : 'document'
}

export { FILE_NAME_MAX_LENGTH }
