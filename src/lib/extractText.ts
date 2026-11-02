import {
  MAX_EXTRACTED_CHARACTERS,
  MAX_FILE_BYTES,
  SIGNATURE_PREFIX_BYTES,
  SUPPORTED_MIME_TYPES,
  isWithinSizeLimit,
  sniffFileKind,
  type SupportedFileKind,
} from '../../shared/fileRules'

/** A user-facing validation problem — always safe to show directly. */
export class FileValidationError extends Error {}

export type ExtractedDocument = {
  kind: SupportedFileKind
  mimeType: string
  fileName: string
  fileSize: number
  text: string
  truncated: boolean
}

async function readLeadingBytes(file: File, count: number): Promise<Uint8Array> {
  const slice = file.slice(0, count)
  const buffer = await slice.arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Validates a user-selected file and extracts its text entirely in the
 * browser. Nothing but the extracted text and a verified kind/size ever
 * needs to leave the device for the upload step that follows.
 */
export async function extractDocumentText(file: File): Promise<ExtractedDocument> {
  if (file.size === 0) {
    throw new FileValidationError('This file is empty.')
  }
  if (!isWithinSizeLimit(file.size)) {
    throw new FileValidationError(`This file is larger than ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`)
  }

  const head = await readLeadingBytes(file, SIGNATURE_PREFIX_BYTES)
  const kind = sniffFileKind(head)
  if (!kind) {
    throw new FileValidationError("Choose a PDF or Word (.docx) file — this file's contents don't match either format.")
  }

  const buffer = await file.arrayBuffer()
  const extracted = kind === 'pdf' ? await extractPdfText(buffer) : await extractDocxText(buffer)

  return {
    kind,
    mimeType: SUPPORTED_MIME_TYPES[kind],
    fileName: file.name,
    fileSize: file.size,
    ...extracted,
  }
}

function finalizeText(rawText: string): { text: string; truncated: boolean } {
  const trimmed = rawText.replace(/\u0000/g, '').trim()
  const truncated = trimmed.length > MAX_EXTRACTED_CHARACTERS
  return { text: truncated ? trimmed.slice(0, MAX_EXTRACTED_CHARACTERS) : trimmed, truncated }
}

async function extractPdfText(buffer: ArrayBuffer): Promise<{ text: string; truncated: boolean }> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>
  try {
    doc = await pdfjs.getDocument({ data: buffer }).promise
  } catch {
    throw new FileValidationError('This PDF looks corrupted and could not be read.')
  }

  let combined = ''
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
      combined += `${pageText}\n`
      if (combined.length > MAX_EXTRACTED_CHARACTERS) break
    }
  } catch {
    throw new FileValidationError('This PDF looks corrupted and could not be fully read.')
  } finally {
    void doc.cleanup()
  }

  const result = finalizeText(combined)
  if (!result.text) {
    throw new FileValidationError('No readable text was found in this PDF (it may be a scanned image without a text layer).')
  }
  return result
}

async function extractDocxText(buffer: ArrayBuffer): Promise<{ text: string; truncated: boolean }> {
  const mammoth = await import('mammoth')

  let rawText: string
  try {
    const result = await mammoth.extractRawText({ arrayBuffer: buffer })
    rawText = result.value
  } catch {
    throw new FileValidationError('This Word document looks corrupted and could not be read.')
  }

  const result = finalizeText(rawText)
  if (!result.text) {
    throw new FileValidationError('No readable text was found in this document.')
  }
  return result
}
