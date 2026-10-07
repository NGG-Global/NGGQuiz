#!/usr/bin/env node
// Load check for live mode.
//
// Joins N anonymous players to a running session through the public API,
// the way a phone does - a players row with a hidden nickname, the quiz and
// question reads the phone makes on joining, and the phone's own session
// follower (src/lib/liveSync.js: a Realtime channel per player on the
// session row, the resync on (re)subscribe and the paced safety poll) -
// then answers each question as it opens, after a random, human-like
// delay. The projector shows the room filling up and the bars rising, as
// it would in the hall.
//
// RUN IT ONLY AGAINST A THROWAWAY SESSION. Every simulated player and every
// answer is a real row in the database. Create a separate test quiz, start
// a session for it, point this script at that session's PIN, and delete the
// test quiz from the library afterwards (deleting a quiz removes its
// sessions, players and answers with it). The script refuses any quiz that
// is not in anonymous live mode, so it cannot fill a real leaderboard.
//
// Usage:
//   node scripts/simulate-live-session.mjs --pin 123456 --players 300
//
// Options:
//   --pin <pin>         the session's 6-digit join code (required)
//   --players <N>       how many phones to simulate, 1-2000 (required)
//   --join-rate <n>     joins per second, default 25 - a QR-scan wave, and
//                       well under Realtime's channel-join limit
//   --max-delay <s>     the latest an answer arrives after a question
//                       opens, default 8
//   --once              answer the open (or next) question, then stop
//   --yes               skip the confirmation prompt
//
// Needs Node 22 or later (Supabase Realtime relies on its built-in
// WebSocket) and the project's VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY,
// read from .env in the repository root or from the environment, which
// takes precedence. Only the public anon key is used: the same key the site
// already ships to every browser.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { followSession, reconnectAfterMs } from '../src/lib/liveSync.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QUIZ_FIELDS = 'kind, scored, anonymous, teams_enabled, team_mode, teams, title'
const QUESTION_FIELDS = 'id, qtype, text, options, meta, position, explanation, time_limit'
const WORDS = ['אמון', 'שקיפות', 'חדשנות', 'שיתוף', 'למידה', 'צמיחה', 'trust', 'focus']

function usage() {
  console.log('Usage: node scripts/simulate-live-session.mjs --pin <pin> --players <N> [--join-rate 25] [--max-delay 8] [--once] [--yes]')
  console.log('Run it only against a throwaway session - see the comment at the top of this file.')
}

function parseArgs(argv) {
  const args = { joinRate: 25, maxDelay: 8, once: false, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => argv[++i]
    if (flag === '--pin') args.pin = value()
    else if (flag === '--players') args.players = Number(value())
    else if (flag === '--join-rate') args.joinRate = Number(value())
    else if (flag === '--max-delay') args.maxDelay = Number(value())
    else if (flag === '--once') args.once = true
    else if (flag === '--yes') args.yes = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`unknown option ${flag}`)
  }
  return args
}

// .env holds KEY=value lines; the environment wins so a run can point
// elsewhere without editing the file
function loadEnv() {
  const env = {}
  const file = path.join(ROOT, '.env')
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return { ...env, ...process.env }
}

// the same hidden nickname the phone generates: "anon-" and 8 hex digits
function anonymousNickname() {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return `anon-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function shuffled(n) {
  const arr = Array.from({ length: n }, (_, i) => i)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// a plausible answer for any question type, shaped as the phone sends it
function randomAnswer(q) {
  const pick = (n) => Math.floor(Math.random() * n)
  switch (q.qtype) {
    case 'true_false':
      return { answer_index: pick(2) }
    case 'multiple_choice':
    case 'poll':
      return { answer_index: pick(q.options?.length || 2) }
    case 'scale': {
      const min = Number(q.meta?.min ?? 1)
      const max = Number(q.meta?.max ?? 5)
      return { answer_index: min + pick(max - min + 1) }
    }
    case 'word_cloud':
      return { answer: { text: WORDS[pick(WORDS.length)] } }
    case 'ranking':
      return { answer: { order: shuffled(q.options?.length || 0) } }
    case 'hotspot':
      return { answer: { x: Math.round(Math.random() * 1000) / 10, y: Math.round(Math.random() * 1000) / 10 } }
    default:
      return { answer_index: 0 }
  }
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- shared run state ----------

const stats = {
  joined: 0,
  joinFailed: 0,
  subscribed: 0,
  channelProblems: 0,
  joinMs: [],
  answerMs: [],
  answered: new Map(), // question index -> answers accepted
  answerErrors: new Map(), // message -> count
  seen: new Map(), // "status:index" -> {first, last, players, realtime, http}
}

function countError(map, message) {
  map.set(message, (map.get(message) || 0) + 1)
}

// how quickly one host action reached every phone, and which path brought
// it there first (only a phone's first sighting counts): Realtime, or one
// of the follower's HTTP reads (poll, resync on subscribe)
function observe(session, via, phone) {
  const key = `${session.status}:${session.current_index}`
  const now = Date.now()
  const entry = stats.seen.get(key) || { first: now, last: now, players: new Set(), realtime: 0, http: 0 }
  if (!entry.players.has(phone)) {
    entry.players.add(phone)
    entry.last = now
    entry[via === 'realtime' ? 'realtime' : 'http'] += 1
  }
  stats.seen.set(key, entry)
}

class SimulatedPhone {
  constructor(index, ctx) {
    this.index = index
    this.ctx = ctx
    this.answeredIndex = null
    this.scheduledIndex = null
    this.stopped = false
    // one client per phone, so each holds its own Realtime connection, with
    // the site's spread-out reconnect back-off
    this.client = createClient(ctx.url, ctx.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { reconnectAfterMs },
    })
  }

  async join() {
    const started = performance.now()
    for (let attempt = 0; attempt <= 3; attempt++) {
      // the phone picks its player id, so a retried join finds its own row
      const { data, error } = await this.client
        .from('players')
        .insert({ id: crypto.randomUUID(), session_id: this.ctx.session.id, nickname: anonymousNickname(), team: null })
        .select()
        .single()
      if (!error) {
        this.id = data.id
        stats.joined += 1
        stats.joinMs.push(performance.now() - started)
        // what the phone reads once it is in: the quiz and its questions
        await Promise.all([
          this.client.from('quizzes').select(QUIZ_FIELDS).eq('id', this.ctx.session.quiz_id).single(),
          this.client.from('questions').select(QUESTION_FIELDS).eq('quiz_id', this.ctx.session.quiz_id).order('position'),
        ])
        return true
      }
      if (error.code !== '23505') {
        stats.joinFailed += 1
        countError(stats.answerErrors, `join: ${error.message}`)
        return false
      }
    }
    stats.joinFailed += 1
    return false
  }

  // the phone's follower, unchanged: Realtime on the session row, a read on
  // every (re)subscription, and the paced safety poll
  listen() {
    let wasHealthy = false
    this.follower = followSession(this.client, this.ctx.session.id, {
      label: 'play',
      onState: (row, via) => this.onSession(row, via),
      onHealth: (healthy) => {
        if (healthy && !wasHealthy) stats.subscribed += 1
        if (!healthy && wasHealthy) stats.channelProblems += 1
        wasHealthy = healthy
      },
    })
  }

  onSession(session, via) {
    if (this.stopped) return
    observe(session, via, this.index)
    if (session.status === 'finished') {
      this.ctx.onFinished()
      return
    }
    const index = session.current_index
    if (session.status !== 'question' || index === this.answeredIndex || index === this.scheduledIndex) return
    const question = this.ctx.questions[index]
    if (!question) return
    this.scheduledIndex = index
    // answer like a person: after a moment of reading, never past the timer
    const deadline = question.time_limit
      ? new Date(session.question_started_at).getTime() + question.time_limit * 1000 - 1500
      : Infinity
    const wanted = 500 + Math.random() * Math.max(0, this.ctx.maxDelay * 1000 - 500)
    const delay = Math.max(0, Math.min(wanted, deadline - Date.now()))
    this.answerTimer = setTimeout(() => this.answer(session, question), delay)
  }

  async answer(session, question) {
    if (this.stopped) return
    const started = performance.now()
    const { error } = await this.client
      .from('answers')
      .insert({ session_id: session.id, question_id: question.id, player_id: this.id, ...randomAnswer(question) })
      .select('is_correct, points, answer_index, answer')
      .single()
    this.answeredIndex = session.current_index
    if (!error || error.code === '23505') {
      stats.answerMs.push(performance.now() - started)
      stats.answered.set(session.current_index, (stats.answered.get(session.current_index) || 0) + 1)
    } else {
      countError(stats.answerErrors, `answer: ${error.message}`)
    }
    this.ctx.onAnswerAttempt()
  }

  async stop() {
    this.stopped = true
    this.follower?.stop()
    clearTimeout(this.answerTimer)
    await this.client.removeAllChannels()
  }
}

function printSummary(ctx) {
  console.log('\n--- summary ---')
  console.log(`players joined: ${stats.joined}/${ctx.players}${stats.joinFailed ? ` (${stats.joinFailed} failed)` : ''}`)
  console.log(`realtime subscriptions: ${stats.subscribed}${stats.channelProblems ? `, drops reported: ${stats.channelProblems}` : ''}`)
  console.log(`join time  p50 ${percentile(stats.joinMs, 50)} ms, p95 ${percentile(stats.joinMs, 95)} ms`)
  console.log(`answer time p50 ${percentile(stats.answerMs, 50)} ms, p95 ${percentile(stats.answerMs, 95)} ms`)
  for (const [index, count] of [...stats.answered].sort((a, b) => a[0] - b[0])) {
    console.log(`question ${index + 1}: ${count} answers accepted`)
  }
  for (const [key, entry] of stats.seen) {
    if (key.startsWith('lobby')) continue
    console.log(`state ${key}: reached ${entry.players.size} phones within ${entry.last - entry.first} ms (first via realtime ${entry.realtime}, via an HTTP read ${entry.http})`)
  }
  for (const [message, count] of stats.answerErrors) console.log(`error x${count}: ${message}`)
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    usage()
    process.exit(1)
  }
  if (args.help) return usage()
  if (!/^\d{6}$/.test(args.pin || '') || !Number.isInteger(args.players) || args.players < 1 || args.players > 2000) {
    usage()
    process.exit(1)
  }
  if (typeof WebSocket === 'undefined') {
    console.error('Node 22 or later is required: Supabase Realtime needs the built-in WebSocket.')
    process.exit(1)
  }

  const env = loadEnv()
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    console.error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing (.env or environment).')
    process.exit(1)
  }

  const lookup = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: session, error: sErr } = await lookup
    .from('game_sessions')
    .select('*')
    .eq('pin', args.pin)
    .neq('status', 'finished')
    .maybeSingle()
  if (sErr) throw new Error(`could not look up the session: ${sErr.message}`)
  if (!session) {
    console.error(`No open session with PIN ${args.pin}.`)
    process.exit(1)
  }
  const [{ data: quiz, error: qErr }, { data: questions }] = await Promise.all([
    lookup.from('quizzes').select(QUIZ_FIELDS).eq('id', session.quiz_id).single(),
    lookup.from('questions').select(QUESTION_FIELDS).eq('quiz_id', session.quiz_id).order('position'),
  ])
  if (qErr) throw new Error(`could not read the quiz (is the live-mode migration applied?): ${qErr.message}`)
  // bots must never land on a real leaderboard
  if (quiz.kind !== 'quiz' || quiz.scored !== false || quiz.anonymous !== true) {
    console.error(`"${quiz.title}" is not an anonymous live quiz. The simulator only runs against those.`)
    process.exit(1)
  }

  console.log(`Target: "${quiz.title}" - PIN ${args.pin}, status ${session.status}, ${questions?.length ?? 0} questions.`)
  console.log(`This adds ${args.players} simulated players and their answers as real rows in the database.`)
  if (!args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const typed = (await rl.question('Type the PIN again to continue: ')).trim()
    rl.close()
    if (typed !== args.pin) {
      console.log('Not confirmed - nothing was written.')
      return
    }
  }

  let done = null
  const finished = new Promise((resolve) => { done = resolve })
  const phones = []
  const ctx = {
    url,
    key,
    session,
    questions: questions || [],
    players: args.players,
    maxDelay: args.maxDelay,
    finishedAt: null,
    onFinished() {
      if (ctx.finishedAt) return
      ctx.finishedAt = Date.now()
      // give the slower phones a moment to see the end too
      setTimeout(done, 6000)
    },
    attempts: 0,
    // --once ends when every phone that joined has tried its one answer
    onAnswerAttempt() {
      ctx.attempts += 1
      if (args.once && ctx.attempts >= stats.joined) done()
    },
  }

  const status = setInterval(() => {
    const answers = [...stats.answered].map(([i, c]) => `q${i + 1}:${c}`).join(' ') || '-'
    console.log(`joined ${stats.joined}/${args.players}  realtime ${stats.subscribed}  answers ${answers}`)
  }, 3000)

  const stop = async () => {
    clearInterval(status)
    await Promise.all(phones.map((p) => p.stop()))
    printSummary(ctx)
  }
  process.once('SIGINT', () => { stop().then(() => process.exit(0)) })

  // join in a wave, as a hall scanning a QR code does
  const gap = 1000 / Math.max(1, args.joinRate)
  for (let i = 0; i < args.players; i++) {
    const phone = new SimulatedPhone(i, ctx)
    phones.push(phone)
    phone.join().then((ok) => { if (ok) phone.listen() })
    await sleep(gap)
  }

  await finished
  await stop()
  process.exit(0)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
