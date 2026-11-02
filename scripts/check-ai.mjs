// Sends one tiny test request to each AI provider using the values in .env,
// so you can see which key, model or billing setting is wrong. It costs a
// fraction of a cent and NEVER prints a key or any raw provider response.
//
// Run from the project folder (after "node scripts/check-env.mjs" is clean):
//   node scripts/check-ai.mjs

import { existsSync } from 'node:fs'

if (!existsSync('.env')) {
  console.log('FIX   No file named exactly ".env" in this folder. Run: copy .env.example .env')
  process.exit(1)
}
process.loadEnvFile('.env')

let problems = 0
const ok = (m) => console.log(`  ok    ${m}`)
const bad = (m) => {
  problems += 1
  console.log(`  FIX   ${m}`)
}
const skip = (m) => console.log(`  skip  ${m}`)

async function post(url, headers, body) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const text = await response.text().catch(() => '')
    return { status: response.status, text: text.toLowerCase() }
  } catch {
    return { status: 0, text: '' }
  }
}

async function checkAnthropic(label, variable) {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  const model = process.env[variable]?.trim()
  if (!key) return bad('ANTHROPIC_API_KEY is empty or missing.')
  if (!model) return bad(`${variable} is empty or missing.`)

  const { status, text } = await post(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the word OK.' }] },
  )

  if (status === 200) return ok(`Anthropic ${label} model "${model}" answered`)
  if (status === 0) return bad('Could not reach api.anthropic.com. Check your internet connection or firewall.')
  if (status === 401) return bad('Anthropic rejected ANTHROPIC_API_KEY. Create a new key in the Anthropic Console (it starts with sk-ant-).')
  if (status === 403) return bad(`This Anthropic key is not allowed to use "${model}".`)
  if (status === 404) return bad(`Anthropic does not recognise the model "${model}" set in ${variable}. Try claude-haiku-5-5 or claude-sonnet-5-5.`)
  if (status === 400 && text.includes('credit balance')) return bad('The Anthropic account has no credit. Add credit in the Anthropic Console under Billing (API credit is separate from a Claude.ai plan).')
  if (status === 429) return bad('Anthropic is rate-limiting this key right now. Wait a minute and run this again.')
  return bad(`Anthropic answered with an unexpected status (${status}) for ${variable}.`)
}

async function listGroqChatModels(key) {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) return []
    const payload = await response.json()
    return (payload.data ?? [])
      .map((entry) => String(entry.id))
      .filter((id) => !/whisper|guard|tts|embed|orpheus|distil/i.test(id))
      .sort()
  } catch {
    return []
  }
}

async function checkGroq() {
  const key = process.env.GROQ_API_KEY?.trim()
  if (!key) return skip('GROQ_API_KEY is empty, so the resume analyzer is not configured.')
  const model = process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile'

  const { status } = await post(
    'https://api.groq.com/openai/v1/chat/completions',
    { authorization: `Bearer ${key}` },
    { model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the word OK.' }] },
  )

  if (status === 200) return ok(`Groq model "${model}" answered`)
  if (status === 0) return bad('Could not reach api.groq.com. Check your internet connection or firewall.')
  if (status === 401) return bad('Groq rejected GROQ_API_KEY. Create a new key at console.groq.com (it starts with gsk_).')
  if (status === 404) {
    bad(`Your Groq account cannot use the model "${model}".`)
    const available = await listGroqChatModels(key)
    if (available.length) {
      console.log('        Models your Groq account can use (put one in GROQ_MODEL in .env):')
      for (const id of available) console.log(`          ${id}`)
    }
    return
  }
  if (status === 429) return bad('Groq is rate-limiting this key right now. Wait a minute and run this again.')
  return bad(`Groq answered with an unexpected status (${status}).`)
}

console.log('Testing AI providers (keys are never printed)\n')
const provider = (process.env.AI_PROVIDER ?? 'anthropic').trim().toLowerCase()
console.log(`AI_PROVIDER = ${provider === 'groq' ? 'groq' : 'anthropic'}\n`)

if (provider === 'groq') {
  console.log('Anthropic (not used while AI_PROVIDER=groq)')
  skip('skipped')
} else {
  console.log('Anthropic (chat, summaries, charts, plans, presentations)')
  await checkAnthropic('chat', 'ANTHROPIC_MODEL_CHAT')
  await checkAnthropic('generation', 'ANTHROPIC_MODEL_GENERATION')
}

console.log(provider === 'groq' ? '\nGroq (everything, including the resume analyzer)' : '\nGroq (resume analyzer)')
await checkGroq()

console.log(`\n${problems} to fix.`)
if (problems) {
  console.log('Fix the lines marked FIX in .env, save, restart the dev server, then run this again.')
  process.exit(1)
}
console.log('Both providers answered. If the app still fails, restart the dev server so it reads the current .env.')
