// One JSON object per line on stdout/stderr, ready for any log collector.
// Never pass secrets, tokens, request bodies or query strings in here.

export type LogFields = Record<string, unknown>

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}
