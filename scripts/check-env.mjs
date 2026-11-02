// Checks your .env file for the mistakes that stop Clario from running.
// It NEVER prints a value, so the output is safe to paste into a chat.
//
// Run from the project folder:   node scripts/check-env.mjs

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.cwd(), '.env')
let problems = 0
let warnings = 0

const ok = (m) => console.log(`  ok    ${m}`)
const bad = (m) => {
  problems += 1
  console.log(`  FIX   ${m}`)
}
const warn = (m) => {
  warnings += 1
  console.log(`  warn  ${m}`)
}
const heading = (m) => console.log(`\n${m}`)

if (!existsSync(file)) {
  console.log('FIX   No file named exactly ".env" in this folder.')
  console.log('      Run:  copy .env.example .env   then fill in the values and run this again.')
  process.exit(1)
}

const raw = readFileSync(file)
if ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff)) {
  console.log('FIX   .env is saved as UTF-16 (common after using ">" in PowerShell).')
  console.log('      Open it in Notepad, choose File > Save As, set Encoding to UTF-8, and save.')
  process.exit(1)
}

const text = raw.toString('utf8').replace(/^﻿/, '')
const values = new Map()
const lineNumbers = new Map()

text.split(/\r?\n/).forEach((line, index) => {
  if (!line.trim() || line.trim().startsWith('#')) return
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!match) return
  const [, name, rest] = match
  let value = rest.trim()
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1).trim()
  values.set(name, value)
  const seen = lineNumbers.get(name) ?? []
  seen.push(index + 1)
  lineNumbers.set(name, seen)
})

const val = (name) => values.get(name) ?? ''

function keyKind(value) {
  if (value.startsWith('sb_secret_')) return 'secret'
  if (value.startsWith('sb_publishable_')) return 'publishable'
  const parts = value.split('.')
  if (parts.length === 3 && value.startsWith('eyJ')) {
    try {
      const role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role
      if (role === 'anon') return 'anon'
      if (role === 'service_role') return 'service_role'
    } catch {
      /* fall through */
    }
    return 'jwt'
  }
  return 'unknown'
}

function looksLikeKey(value) {
  return /^(sb_|eyJ|sk-|gsk_)/.test(value)
}

function checkHttpsUrl(name, { required = true } = {}) {
  const value = val(name)
  if (!value) {
    if (required) bad(`${name} is empty or missing.`)
    return null
  }
  if (/^rediss?:\/\//i.test(value)) {
    bad(`${name} is a redis:// address. Use the REST URL that starts with https:// instead.`)
    return null
  }
  let url
  try {
    url = new URL(value)
  } catch {
    bad(
      looksLikeKey(value)
        ? `${name} holds an API key, not a URL. It must start with https://`
        : `${name} is not a full URL. It must start with https://`,
    )
    return null
  }
  if (url.protocol !== 'https:') {
    bad(`${name} must start with https://`)
    return null
  }
  ok(`${name} is a valid https URL`)
  return url
}

function checkPresent(name, { required = true, minLength = 1 } = {}) {
  const value = val(name)
  if (!value) {
    if (required) bad(`${name} is empty or missing.`)
    else warn(`${name} is empty (optional).`)
    return ''
  }
  if (value.length < minLength) {
    bad(`${name} looks too short to be real.`)
    return value
  }
  if (/\s/.test(value)) {
    bad(`${name} contains a space. Remove spaces and line breaks from the value.`)
    return value
  }
  ok(`${name} is set`)
  return value
}

console.log('Checking .env (values are never printed)')

heading('Duplicate lines')
let duplicates = 0
for (const [name, lines] of lineNumbers) {
  if (lines.length > 1) {
    duplicates += 1
    bad(`${name} appears on lines ${lines.join(' and ')}. Keep only one.`)
  }
}
if (!duplicates) ok('no variable is defined twice')

heading('Supabase (browser)')
const viteUrl = checkHttpsUrl('VITE_SUPABASE_URL')
const viteKey = checkPresent('VITE_SUPABASE_ANON_KEY', { minLength: 20 })
if (viteKey) {
  const kind = keyKind(viteKey)
  if (kind === 'secret' || kind === 'service_role') {
    bad('VITE_SUPABASE_ANON_KEY is a SECRET key. Use the publishable (or anon) key. Secret keys must never reach the browser.')
  }
}

heading('Supabase (server)')
const serverUrl = checkHttpsUrl('SUPABASE_URL')
const serverKey = checkPresent('SUPABASE_ANON_KEY', { minLength: 20 })
if (serverKey) {
  const kind = keyKind(serverKey)
  if (kind === 'secret') {
    bad('SUPABASE_ANON_KEY holds an sb_secret_ key. Use the publishable key (the same one as VITE_SUPABASE_ANON_KEY).')
  } else if (kind === 'service_role') {
    bad('SUPABASE_ANON_KEY holds the service_role key, which bypasses row-level security. Use the publishable or anon key.')
  } else if (kind === 'publishable' || kind === 'anon') {
    ok(`SUPABASE_ANON_KEY is a ${kind} key (correct kind)`)
  } else {
    warn('SUPABASE_ANON_KEY is not a recognised Supabase key format. Double-check it.')
  }
}
if (viteUrl && serverUrl && viteUrl.origin !== serverUrl.origin) {
  bad('VITE_SUPABASE_URL and SUPABASE_URL point to different projects. They must be identical.')
}

heading('File storage')
const endpoint = checkHttpsUrl('R2_ENDPOINT')
checkPresent('R2_BUCKET_NAME')
checkPresent('R2_ACCESS_KEY_ID', { minLength: 8 })
checkPresent('R2_SECRET_ACCESS_KEY', { minLength: 8 })
if (endpoint && endpoint.hostname.endsWith('supabase.co')) {
  if (!endpoint.pathname.replace(/\/$/, '').endsWith('/storage/v1/s3')) {
    warn('R2_ENDPOINT for Supabase Storage normally ends with /storage/v1/s3.')
  }
  if (!val('S3_REGION')) bad('S3_REGION is empty. Set it to the region shown on the Supabase Storage S3 page.')
  else ok('S3_REGION is set')
  if (val('S3_FORCE_PATH_STYLE').toLowerCase() !== 'true') bad('S3_FORCE_PATH_STYLE must be true for Supabase Storage.')
  else ok('S3_FORCE_PATH_STYLE is true')
}

heading('Rate limiting (Upstash)')
const upstash = checkHttpsUrl('UPSTASH_REDIS_REST_URL')
if (upstash && !upstash.hostname.endsWith('upstash.io')) warn('UPSTASH_REDIS_REST_URL does not look like an upstash.io address.')
checkPresent('UPSTASH_REDIS_REST_TOKEN', { minLength: 20 })

heading('AI providers')
const provider = (val('AI_PROVIDER') || 'anthropic').toLowerCase()
if (provider !== 'anthropic' && provider !== 'groq') {
  bad('AI_PROVIDER must be either anthropic or groq (or left out for anthropic).')
} else {
  ok(`AI_PROVIDER is ${provider}${val('AI_PROVIDER') ? '' : ' (default)'}`)
}
const groqForEverything = provider === 'groq'

if (groqForEverything) {
  ok('Anthropic settings are not needed while AI_PROVIDER=groq')
} else {
  const anthropicKey = checkPresent('ANTHROPIC_API_KEY', { minLength: 20 })
  if (anthropicKey && !anthropicKey.startsWith('sk-ant-')) warn('ANTHROPIC_API_KEY does not start with sk-ant-.')
  const KNOWN_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']
  for (const name of ['ANTHROPIC_MODEL_CHAT', 'ANTHROPIC_MODEL_GENERATION']) {
    const model = checkPresent(name)
    if (model && !KNOWN_MODELS.includes(model)) {
      warn(`${name} is not a model ID I recognise. If AI calls fail with "does not recognise the model", use claude-haiku-5-5 (chat) and claude-sonnet-5-5 (generation).`)
    }
  }
}

const groqKey = checkPresent('GROQ_API_KEY', { required: groqForEverything, minLength: 20 })
if (groqKey && !groqKey.startsWith('gsk_')) warn('GROQ_API_KEY does not start with gsk_.')

console.log(`\n${problems} to fix, ${warnings} warning${warnings === 1 ? '' : 's'}.`)
if (problems) {
  console.log('Fix the lines marked FIX, save .env, restart the dev server, then run this again.')
  process.exit(1)
}
console.log('Looks good. Restart the dev server so it picks up the file.')
