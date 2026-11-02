import { describe, expect, it } from 'vitest'
import { BadRequestError, readJsonBody, type ApiRequest } from '../http'

function reqWith(options: { body?: unknown; chunks?: string[]; contentLength?: number }): ApiRequest {
  const req = {
    headers: options.contentLength === undefined ? {} : { 'content-length': String(options.contentLength) },
    async *[Symbol.asyncIterator]() {
      for (const chunk of options.chunks ?? []) yield Buffer.from(chunk)
    },
  } as Record<string | symbol, unknown>
  if ('body' in options) req.body = options.body
  return req as unknown as ApiRequest
}

describe('readJsonBody', () => {
  it('uses the body the platform already parsed (vercel dev leaves the stream empty)', async () => {
    const parsed = { fileName: 'a (1).pdf', fileSize: 10 }
    const req = reqWith({ body: parsed, chunks: [] })
    await expect(readJsonBody(req)).resolves.toEqual(parsed)
  })

  it('parses a pre-read string or Buffer body', async () => {
    await expect(readJsonBody(reqWith({ body: '{"a":1}' }))).resolves.toEqual({ a: 1 })
    await expect(readJsonBody(reqWith({ body: Buffer.from('{"b":2}') }))).resolves.toEqual({ b: 2 })
  })

  it('treats an empty pre-read body as an empty object', async () => {
    await expect(readJsonBody(reqWith({ body: '' }))).resolves.toEqual({})
  })

  it('rejects an invalid pre-read JSON string', async () => {
    await expect(readJsonBody(reqWith({ body: '{oops' }))).rejects.toBeInstanceOf(BadRequestError)
  })

  it('rejects a body whose declared length is over the limit', async () => {
    await expect(readJsonBody(reqWith({ contentLength: 3 * 1024 * 1024, body: {} }))).rejects.toBeInstanceOf(BadRequestError)
  })

  it('falls back to reading the stream when no pre-read body exists', async () => {
    await expect(readJsonBody(reqWith({ chunks: ['{"x":', '5}'] }))).resolves.toEqual({ x: 5 })
  })

  it('returns an empty object for an empty stream', async () => {
    await expect(readJsonBody(reqWith({ chunks: [] }))).resolves.toEqual({})
  })
})
