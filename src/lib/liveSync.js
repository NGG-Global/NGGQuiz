// Keeping a screen in step with a live game session.
//
// Shared by the phone (Play), the projector (Host) and the load simulator in
// scripts/, so the simulator measures the behaviour the hall actually gets.
// Plain JavaScript with no build-time imports, so Node can load it too.

// ---------- Realtime reconnect back-off ----------

// After a Wi-Fi drop in the hall, or a Realtime disconnect for going over
// the plan's message rate, every phone loses its connection at the same
// moment. The library's stepped back-off (1, 2, 5, 10 s) would bring them
// all back in lockstep - a burst of reconnects and channel joins that can
// trip the joins-per-second limit and disconnect them again. Each step is
// spread over 50%-150% of its length to break the lockstep.
const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10000]

export function reconnectAfterMs(tries) {
  const step = RECONNECT_STEPS_MS[tries - 1] ?? RECONNECT_STEPS_MS[RECONNECT_STEPS_MS.length - 1]
  return Math.round(step * (0.5 + Math.random()))
}

// ---------- the order of game states ----------

// A game only moves forward: question n, its reveal, maybe the leaderboard,
// then question n + 1, until it is finished. Two reads of the session can
// land out of order - a slow poll sent before the host's click can answer
// after the Realtime event for that click - and taking the late one would
// flip the screen back to the previous step. So a screen only ever takes a
// state that is later than the one it holds.
const PHASE_ORDER = { lobby: 0, question: 1, reveal: 2, leaderboard: 3, finished: 4 }

function startedAt(session) {
  const ms = session.question_started_at ? Date.parse(session.question_started_at) : 0
  return Number.isNaN(ms) ? 0 : ms
}

// > 0 when a is later in the game than b, 0 when it is the same state
export function compareSessions(a, b) {
  const aDone = a.status === 'finished'
  const bDone = b.status === 'finished'
  if (aDone !== bDone) return aDone ? 1 : -1
  if (a.current_index !== b.current_index) return a.current_index - b.current_index
  const phase = (PHASE_ORDER[a.status] ?? 0) - (PHASE_ORDER[b.status] ?? 0)
  if (phase) return phase
  // the same question opened again (a restart before start_question was
  // made idempotent): the later start wins
  if (a.question_started_at === b.question_started_at) return 0
  return startedAt(a) - startedAt(b)
}

// The state to hold once `incoming` arrives: `held` when incoming is not
// later (so React keeps the same object and skips the render), else incoming.
export function newerSession(held, incoming) {
  if (!incoming) return held
  if (!held || held.id !== incoming.id) return incoming
  return compareSessions(incoming, held) > 0 ? incoming : held
}

// ---------- reads that cannot hang ----------

// A request on a flaky mobile network can hang for minutes. Every read made
// to keep a screen in step gives up after `ms`, so the next one can go out.
export function withTimeout(query, ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return query.abortSignal(AbortSignal.timeout(ms))
  }
  if (typeof AbortController === 'undefined') return query
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return query.abortSignal(controller.signal)
}

// ---------- following a session ----------

// Poll pace (each delay is drawn afresh within ±20%, so phones that joined
// together never poll in step):
//   healthy   the channel is subscribed - the poll is only a safety net
//   degraded  the channel is down, or the page has just woken up and the
//             socket may be dead without knowing it yet
export const POLL_HEALTHY_MS = 8000
export const POLL_DEGRADED_MS = 3000
// how long after waking the poll stays at the degraded pace: long enough for
// the library's heartbeat to find a dead socket and reconnect it
const WAKE_WINDOW_MS = 30000
// a re-subscription reads after a random delay up to this long
const RESUBSCRIBE_SPREAD_MS = 2000
const READ_TIMEOUT_MS = 8000
// a read older than this no longer blocks a new one on wake
const STALE_READ_MS = 2000

// Follows one game session's row and reports each later state once, through
// onState(row, via) - via is 'realtime', 'subscribe', 'wake', 'poll' or
// 'manual', for the simulator's statistics.
//
// Realtime pushes the host's changes the moment they happen. It is not
// enough on its own: an event sent while a phone is locked, in the
// background or between networks is never replayed, and Supabase closes the
// connections of a project that goes over its Realtime message rate
// (supabase-js reconnects once the rate drops). So the row is also read:
//   - whenever the channel (re)subscribes; after a drop, with a short random
//     delay, so a hall of phones reconnecting together does not read at once
//   - when the page becomes visible again or the network comes back
//   - on a poll, at the healthy or degraded pace above; never while the
//     page is hidden, since waking reads at once anyway
//
// Returns { sync, stop }: sync() reads now, stop() tears everything down.
export function followSession(client, sessionId, { onState, onHealth, label = 'play' } = {}) {
  let stopped = false
  let held = null
  let healthy = false
  let subscribedOnce = false
  let fastUntil = 0
  let pollTimer = null
  let spreadTimer = null
  let inflight = null
  let inflightSince = 0

  const hasDocument = typeof document !== 'undefined'
  const hidden = () => hasDocument && document.visibilityState === 'hidden'

  function deliver(row, via) {
    if (stopped || !row) return
    const next = newerSession(held, row)
    if (next === held) return
    held = next
    onState?.(row, via)
  }

  function sync(via = 'manual', { fresh = false } = {}) {
    if (stopped) return Promise.resolve()
    if (inflight && !(fresh && Date.now() - inflightSince > STALE_READ_MS)) return inflight
    inflightSince = Date.now()
    const request = withTimeout(
      client.from('game_sessions').select('*').eq('id', sessionId).maybeSingle(),
      READ_TIMEOUT_MS
    )
      .then(({ data }) => deliver(data, via))
      .catch(() => {})
      .finally(() => {
        if (inflight === request) inflight = null
      })
    inflight = request
    return request
  }

  function pollDelay() {
    const fast = !healthy || Date.now() < fastUntil
    return (fast ? POLL_DEGRADED_MS : POLL_HEALTHY_MS) * (0.8 + Math.random() * 0.4)
  }

  function schedulePoll() {
    clearTimeout(pollTimer)
    if (stopped) return
    pollTimer = setTimeout(() => {
      if (!hidden()) sync('poll')
      schedulePoll()
    }, pollDelay())
  }

  function setHealthy(value) {
    if (healthy === value) return
    healthy = value
    onHealth?.(value)
    schedulePoll() // re-plan the next poll at the new pace
  }

  // a fresh topic per subscription: supabase-js hands back an existing
  // channel with the same name, and a channel whose removal timed out
  // (offline) is never torn down - reusing it would silently miss events
  const topic = `${label}-${sessionId}-${Math.random().toString(36).slice(2, 10)}`
  const channel = client
    .channel(topic)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` },
      (payload) => deliver(payload.new, 'realtime')
    )
    .subscribe((status) => {
      if (stopped) return
      if (status === 'SUBSCRIBED') {
        setHealthy(true)
        if (!subscribedOnce) {
          subscribedOnce = true
          sync('subscribe')
        } else {
          clearTimeout(spreadTimer)
          spreadTimer = setTimeout(() => sync('subscribe'), Math.random() * RESUBSCRIBE_SPREAD_MS)
        }
      } else {
        // CHANNEL_ERROR, TIMED_OUT or CLOSED: the library rejoins by itself;
        // until then the poll runs at the degraded pace
        setHealthy(false)
      }
    })

  function onWake() {
    if (hidden()) return
    fastUntil = Date.now() + WAKE_WINDOW_MS
    sync('wake', { fresh: true })
    schedulePoll()
  }

  if (hasDocument) {
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)
    window.addEventListener('pageshow', onWake)
  }
  schedulePoll()

  return {
    sync: () => sync('manual', { fresh: true }),
    stop() {
      stopped = true
      clearTimeout(pollTimer)
      clearTimeout(spreadTimer)
      if (hasDocument) {
        document.removeEventListener('visibilitychange', onWake)
        window.removeEventListener('focus', onWake)
        window.removeEventListener('online', onWake)
        window.removeEventListener('pageshow', onWake)
      }
      client.removeChannel(channel)
    },
  }
}
