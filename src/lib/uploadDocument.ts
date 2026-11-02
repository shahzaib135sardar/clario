import { confirmDocumentUpload, createDocument, type DocumentSummary } from './api'
import { extractDocumentText, FileValidationError } from './extractText'

export type UploadStage = 'reading' | 'uploading' | 'finishing' | 'done'

export type UploadProgress = (stage: UploadStage) => void

/**
 * Full client-side upload pipeline for one file:
 *   1. Extract + validate text locally (nothing else leaves the device yet).
 *   2. Ask the API to create the document row and hand back a short-lived,
 *      signed R2 upload URL.
 *   3. PUT the raw file straight to R2 — it never passes through our own
 *      serverless function.
 *   4. Ask the API to confirm the upload, which re-verifies the object on
 *      the server before marking the document ready.
 */
export async function uploadDocument(file: File, onProgress?: UploadProgress): Promise<DocumentSummary> {
  onProgress?.('reading')
  const extracted = await extractDocumentText(file)

  const { uploadUrl, documentId } = await createDocument({
    fileName: extracted.fileName,
    fileType: extracted.mimeType,
    fileSize: extracted.fileSize,
    extractedText: extracted.text,
  })

  onProgress?.('uploading')
  const putResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': extracted.mimeType },
    body: file,
  })
  if (!putResponse.ok) {
    throw new FileValidationError('The upload did not complete. Please try again.')
  }

  onProgress?.('finishing')
  const { document } = await confirmDocumentUpload(documentId)

  onProgress?.('done')
  return document
}

export { FileValidationError }
