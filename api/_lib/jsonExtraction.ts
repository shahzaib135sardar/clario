export class AiResponseParseError extends Error {}

/**
 * Pulls one JSON object out of a model's text reply. Even when a prompt
 * insists on "JSON only," a model can still wrap it in prose or a fenced
 * code block — this tries the whole trimmed string first, then a
 * ```json fence, then the first balanced {...} span, rather than
 * assuming any one shape and throwing on the first mismatch.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const candidates: string[] = [trimmed]

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim())

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next candidate shape
    }
  }

  throw new AiResponseParseError('The AI response could not be parsed as JSON.')
}
