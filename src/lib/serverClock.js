// The database clock, as seen from this device.
//
// Countdowns compare a server timestamp (question_started_at) with the
// device clock, so a phone or projector whose clock is a few seconds off
// shows the wrong time left - and a projector running fast would close a
// timed question early. The offset to the database clock is measured from
// the round trip of a tiny RPC and applied wherever a deadline is checked.
//
// Without the server_time() function (database not migrated yet), or while
// the measurement has not come back, the offset stays 0 and the device
// clock is used, exactly as before.

let offsetMs = 0
let measured = false
let pending = null

// a reading whose round trip took longer than this is retried, since half
// the round trip is the measurement's margin of error
const GOOD_ROUND_TRIP_MS = 600
const MAX_SAMPLES = 3

export function serverNow() {
  return Date.now() + offsetMs
}

export function serverClockMeasured() {
  return measured
}

// Measures the offset once per page; later calls reuse the result. A failed
// measurement (offline, function missing) may be retried by calling again.
export function syncServerClock(client) {
  if (measured) return Promise.resolve(offsetMs)
  if (pending) return pending
  pending = (async () => {
    let best = null
    for (let i = 0; i < MAX_SAMPLES; i++) {
      const sent = Date.now()
      const { data, error } = await client.rpc('server_time')
      const received = Date.now()
      if (error || !data) break
      const server = new Date(data).getTime()
      if (Number.isNaN(server)) break
      const roundTrip = received - sent
      if (!best || roundTrip < best.roundTrip) {
        best = { roundTrip, offset: server + roundTrip / 2 - received }
      }
      if (roundTrip <= GOOD_ROUND_TRIP_MS) break
    }
    if (best) {
      offsetMs = Math.round(best.offset)
      measured = true
    }
    return offsetMs
  })()
    .catch(() => offsetMs)
    .finally(() => { pending = null })
  return pending
}
