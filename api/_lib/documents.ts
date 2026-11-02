export type DocumentStatus = 'pending' | 'ready' | 'failed'

export type DocumentRow = {
  id: string
  file_name: string
  file_type: string
  file_size: number
  storage_key: string | null
  status: DocumentStatus
  created_at: string
}

export type DocumentSummary = {
  id: string
  fileName: string
  fileType: string
  fileSize: number
  status: DocumentStatus
  createdAt: string
}

export const DOCUMENT_SELECT_COLUMNS = 'id, file_name, file_type, file_size, storage_key, status, created_at'

export function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    fileName: row.file_name,
    fileType: row.file_type,
    fileSize: row.file_size,
    status: row.status,
    createdAt: row.created_at,
  }
}
