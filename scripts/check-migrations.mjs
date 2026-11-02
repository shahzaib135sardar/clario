// Verifies supabase/migrations: ordered, uniquely timestamped, non-empty, and free
// of unreviewed destructive statements. Run in CI:  node scripts/check-migrations.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NAME_PATTERN = /^\d{12}_[a-z0-9_]+\.sql$/
export const REVIEWED_MARKER = '-- migration-safety: reviewed'
const DESTRUCTIVE = [
  { pattern: /\bdrop\s+table\b/i, label: 'drop table' },
  { pattern: /\btruncate\b/i, label: 'truncate' },
  { pattern: /\bdrop\s+column\b/i, label: 'drop column' },
  { pattern: /\bdelete\s+from\b(?![^;]*\bwhere\b)/i, label: 'delete without where' },
]

export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
}

/** files: [{ name, sql }] in any order. Returns a list of problem strings (empty = fine). */
export function checkMigrations(files) {
  const problems = []
  const names = files.map((file) => file.name)
  for (const file of files) {
    if (!NAME_PATTERN.test(file.name)) problems.push(`${file.name}: name must look like 202610270001_short_description.sql`)
    if (file.sql.trim() === '') problems.push(`${file.name}: file is empty`)
    if (!file.sql.includes(REVIEWED_MARKER)) {
      for (const { pattern, label } of DESTRUCTIVE) {
        if (pattern.test(stripSqlComments(file.sql))) problems.push(`${file.name}: contains "${label}" without the line "${REVIEWED_MARKER}"`)
      }
    }
  }
  const stamps = names.map((name) => name.slice(0, 12))
  const duplicated = stamps.filter((stamp, index) => stamps.indexOf(stamp) !== index)
  for (const stamp of new Set(duplicated)) problems.push(`duplicate migration timestamp ${stamp}`)
  const sorted = [...names].sort()
  if (names.join('|') !== sorted.join('|')) problems.push('migration files are not in timestamp order')
  return problems
}

function main() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
  const problems = checkMigrations(files)
  if (problems.length > 0) {
    console.error(problems.map((problem) => `✗ ${problem}`).join('\n'))
    process.exit(1)
  }
  console.log(`✓ ${files.length} migrations OK`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
