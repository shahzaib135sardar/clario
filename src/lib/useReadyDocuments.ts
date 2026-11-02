import { useEffect, useState } from 'react'
import { listDocuments, type DocumentSummary } from './api'

/** The signed-in user's documents that finished uploading (used by the Jobs and AI chat pages). */
export function useReadyDocuments() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    listDocuments()
      .then(({ documents: fetched }) => {
        if (!cancelled) setDocuments(fetched.filter((doc) => doc.status === 'ready'))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load your documents.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { documents, loading, error }
}
