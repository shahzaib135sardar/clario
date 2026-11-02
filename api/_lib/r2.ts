import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getR2Config } from './env'

const UPLOAD_URL_TTL_SECONDS = 300 // 5 minutes — long enough for a slow upload, short enough to limit replay risk
const DOWNLOAD_URL_TTL_SECONDS = 300 // 5 minutes — regenerated on demand, never stored

let cachedClient: S3Client | null = null

function getClient(): S3Client {
  if (cachedClient) return cachedClient
  const { endpoint, accessKeyId, secretAccessKey, region, forcePathStyle } = getR2Config()
  cachedClient = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
    // Recent SDK versions add CRC32 checksum parameters to presigned PUT URLs
    // by default. A browser upload can't satisfy those, and non-AWS S3
    // providers reject it — only compute checksums when an operation requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return cachedClient
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null | undefined)?.name
  const statusCode = (error as { $metadata?: { httpStatusCode?: number } } | null | undefined)?.$metadata?.httpStatusCode
  return name === 'NotFound' || name === 'NoSuchKey' || statusCode === 404
}

/**
 * Signs a one-time PUT URL scoped to an exact key, content type and size.
 * Because Content-Length is part of what gets signed, the browser's PUT
 * must match it exactly or R2 rejects the request outright — the server
 * still re-verifies the real object afterward rather than trusting this.
 */
export async function createSignedUploadUrl(key: string, contentType: string, contentLength: number): Promise<string> {
  const { bucket } = getR2Config()
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  })
  return getSignedUrl(getClient(), command, { expiresIn: UPLOAD_URL_TTL_SECONDS })
}

/**
 * Signs a one-time GET URL for an object this server already wrote (the
 * generated PPTX, specifically). Short-lived and regenerated per request
 * rather than stored, so a leaked link stops working on its own.
 */
export async function createSignedDownloadUrl(key: string, downloadFileName: string): Promise<string> {
  const { bucket } = getR2Config()
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${downloadFileName.replace(/"/g, '')}"`,
  })
  return getSignedUrl(getClient(), command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS })
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const { bucket } = getR2Config()
  await getClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
}

export type ObjectHead = { size: number; contentType: string | undefined }

export async function headObject(key: string): Promise<ObjectHead | null> {
  const { bucket } = getR2Config()
  try {
    const result = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return { size: result.ContentLength ?? 0, contentType: result.ContentType }
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** Reads only the first `byteCount` bytes — enough to re-check a signature without downloading the whole file. */
export async function readObjectPrefix(key: string, byteCount: number): Promise<Uint8Array | null> {
  const { bucket } = getR2Config()
  try {
    const result = await getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${byteCount - 1}` }),
    )
    if (!result.Body) return null
    return await result.Body.transformToByteArray()
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export async function deleteObject(key: string): Promise<void> {
  const { bucket } = getR2Config()
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}
