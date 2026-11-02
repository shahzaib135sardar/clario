import { createHash } from 'node:crypto'

// Server-side feature flags from environment variables:
//   FEATURE_JOB_SUGGESTIONS=true | false | 25%     (25% = canary cohort)
// A percentage rolls out to a stable slice of users: the same user always gets
// the same answer for the same flag, so a canary doesn't flicker.

export type FlagValue = { kind: 'on' } | { kind: 'off' } | { kind: 'percent'; percent: number }

export function parseFlag(raw: string | undefined, fallback: boolean): FlagValue {
  const value = raw?.trim().toLowerCase()
  if (value === undefined || value === '') return fallback ? { kind: 'on' } : { kind: 'off' }
  if (value === 'true' || value === '1' || value === 'on') return { kind: 'on' }
  if (value === 'false' || value === '0' || value === 'off') return { kind: 'off' }
  const match = /^(\d{1,3}(?:\.\d+)?)%$/.exec(value)
  if (match) {
    const percent = Number(match[1])
    if (percent >= 100) return { kind: 'on' }
    if (percent <= 0) return { kind: 'off' }
    return { kind: 'percent', percent }
  }
  return fallback ? { kind: 'on' } : { kind: 'off' }
}

/** Maps (flag, user) to a stable number in [0, 100). */
export function bucketFor(flagName: string, userId: string): number {
  const digest = createHash('sha256').update(`${flagName}:${userId}`).digest()
  return (digest.readUInt32BE(0) / 0x1_0000_0000) * 100
}

export function isEnabled(flagName: string, userId: string, defaultOn = false, env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = parseFlag(env[`FEATURE_${flagName}`], defaultOn)
  if (flag.kind === 'on') return true
  if (flag.kind === 'off') return false
  return bucketFor(flagName, userId) < flag.percent
}
