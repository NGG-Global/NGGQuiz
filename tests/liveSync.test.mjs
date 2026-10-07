// Behaviour of the live-session follower that every phone runs.
// Run with: npm test  (Node's built-in test runner, no dependencies)
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareSessions,
  newerSession,
  followSession,
  reconnectAfterMs,
  POLL_HEALTHY_MS,
  POLL_DEGRADED_MS,
} from '../src/lib/liveSync.js'

const ID = 'session-1'
const at = (s) => `2026-10-07T09:00:${String(s).padStart(2, '0')}.000000+00:00`
const state = (status, index, started = null) => ({
  id: ID,
  status,
  current_index: index,
  question_started_at: started,
})

// A stand-in for the supabase client: one channel, and session reads whose
// answers the test releases one by one, in any order.
function fakeClient(initialRow) {
  const fake = {
    row: initialRow,
    reads: [], // pending reads: { resolve, row }
    subscribeCallback: null,
    changeCallback: null,
    removed: 0,
    topics: [],
    channel(topic) {
      fake.topics.push(topic)
      const ch = {
        on(_type, _filter, cb) {
          fake.changeCallback = cb
          return ch
        },
        subscribe(cb) {
          fake.subscribeCallback = cb
          return ch
        },
      }
      return ch
    },
    removeChannel() {
      fake.removed += 1
    },
    from() {
      const snapshot = fake.row
      let resolve
      const promise = new Promise((r) => { resolve = r })
      fake.reads.push({ resolve: () => resolve({ data: snapshot, error: null }), row: snapshot })
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => builder,
        abortSignal: () => builder,
        then: (onOk, onErr) => promise.then(onOk, onErr),
      }
      return builder
    },
  }
  return fake
}

const flush = () => new Promise((r) => setImmediate(r))

test('a game only moves forward', () => {
  const lobby = state('lobby', -1)
  const q0 = state('question', 0, at(1))
  const r0 = state('reveal', 0, at(1))
  const l0 = state('leaderboard', 0, at(1))
  const q1 = state('question', 1, at(30))
  const done = state('finished', 1, at(30))
  const order = [lobby, q0, r0, l0, q1, done]
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      const sign = Math.sign(compareSessions(order[i], order[j]))
      assert.equal(sign, Math.sign(i - j), `${order[i].status}:${order[i].current_index} vs ${order[j].status}:${order[j].current_index}`)
    }
  }
  // the same question opened again: the later start is the newer state
  assert.ok(compareSessions(state('question', 2, at(40)), state('question', 2, at(10))) > 0)
})

test('newerSession keeps the held object unless the incoming state is later', () => {
  const held = state('reveal', 3, at(5))
  assert.equal(newerSession(held, state('question', 3, at(5))), held)
  assert.equal(newerSession(held, { ...held }), held)
  const next = state('question', 4, at(9))
  assert.equal(newerSession(held, next), next)
  assert.equal(newerSession(null, next), next)
  assert.equal(newerSession(held, null), held)
  // another session entirely (a new join) always replaces
  const other = { ...state('lobby', -1), id: 'session-2' }
  assert.equal(newerSession(held, other), other)
})

test('a slow read that answers after a Realtime event never rolls the phone back', async () => {
  const fake = fakeClient(state('question', 0, at(1)))
  const seen = []
  const handle = followSession(fake, ID, { onState: (row, via) => seen.push([row.status, via]) })

  fake.subscribeCallback('SUBSCRIBED') // first subscription reads at once
  assert.equal(fake.reads.length, 1)
  // the host reveals; Realtime delivers it before the read comes back
  fake.changeCallback({ new: state('reveal', 0, at(1)) })
  fake.reads[0].resolve() // the read still carries the open question
  await flush()

  assert.deepEqual(seen, [['reveal', 'realtime']])
  handle.stop()
  assert.equal(fake.removed, 1)
})

test('each state is reported once, whichever path brings it first', async () => {
  const fake = fakeClient(state('question', 2, at(3)))
  const seen = []
  const handle = followSession(fake, ID, { onState: (row, via) => seen.push(via) })
  fake.subscribeCallback('SUBSCRIBED')
  fake.reads[0].resolve()
  await flush()
  fake.changeCallback({ new: state('question', 2, at(3)) }) // the same state again
  assert.deepEqual(seen, ['subscribe'])
  handle.stop()
})

test('polls fast while the channel is down and slowly once it is up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeClient(state('lobby', -1))
  const handle = followSession(fake, ID, {})

  // not subscribed yet: the degraded pace (±20%)
  t.mock.timers.tick(POLL_DEGRADED_MS * 1.2 + 1)
  assert.equal(fake.reads.length, 1, 'polled at the degraded pace')
  fake.reads[0].resolve()
  await flush()

  fake.subscribeCallback('SUBSCRIBED')
  assert.equal(fake.reads.length, 2, 'read once on subscribing')
  fake.reads[1].resolve()
  await flush()

  t.mock.timers.tick(POLL_DEGRADED_MS * 1.2 + 1)
  assert.equal(fake.reads.length, 2, 'no fast poll while healthy')
  t.mock.timers.tick(POLL_HEALTHY_MS * 1.2)
  assert.equal(fake.reads.length, 3, 'polled at the healthy pace')
  fake.reads[2].resolve()
  await flush()

  // the connection drops: back to the degraded pace at once
  fake.subscribeCallback('CHANNEL_ERROR')
  t.mock.timers.tick(POLL_DEGRADED_MS * 1.2 + 1)
  assert.equal(fake.reads.length, 4, 'polled at the degraded pace after a drop')
  fake.reads[3].resolve()
  await flush()

  // re-subscribing reads after a random spread, not at once
  fake.subscribeCallback('SUBSCRIBED')
  assert.equal(fake.reads.length, 4, 'no read at the moment of re-subscribing')
  t.mock.timers.tick(2001)
  assert.equal(fake.reads.length, 5, 'read within the spread window')
  handle.stop()
})

test('a read still in flight is not duplicated by the poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeClient(state('lobby', -1))
  const handle = followSession(fake, ID, {})
  t.mock.timers.tick(POLL_DEGRADED_MS * 1.2 + 1)
  t.mock.timers.tick(POLL_DEGRADED_MS * 1.2 + 1)
  assert.equal(fake.reads.length, 1)
  handle.stop()
})

test('every follower subscribes on its own topic', () => {
  const fake = fakeClient(state('lobby', -1))
  const a = followSession(fake, ID, {})
  const b = followSession(fake, ID, {})
  assert.notEqual(fake.topics[0], fake.topics[1])
  a.stop()
  b.stop()
})

test('reconnect delays are spread around each back-off step', () => {
  const random = mock.method(Math, 'random', () => 0)
  assert.equal(reconnectAfterMs(1), 500)
  assert.equal(reconnectAfterMs(3), 2500)
  random.mock.mockImplementation(() => 0.999999)
  assert.equal(reconnectAfterMs(1), 1500)
  assert.equal(reconnectAfterMs(9), 15000)
  random.mock.restore()
})
