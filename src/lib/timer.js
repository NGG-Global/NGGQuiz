// Per-question timer helpers.
//
// A question whose time_limit is null has no limit at all - the host
// closes it manually, exactly as before this feature. When a limit is
// set, the deadline is derived from the SERVER timestamp written by
// start_question(), so every screen counts down against the same clock.

// Limits offered in the editor (seconds).
export const TIMER_PRESETS = [10, 15, 20, 30, 45, 60, 90, 120, 180]

// Grace window (seconds) the database allows past the deadline, so that
// an answer sent in time over a slow mobile network still counts.
export const TIMER_GRACE_SECONDS = 2

// Absolute deadline in epoch ms, or null when the question is untimed.
export function deadlineMs(startedAt, limit) {
  if (!startedAt || !limit) return null
  const start = new Date(startedAt).getTime()
  return Number.isNaN(start) ? null : start + limit * 1000
}

// Whole seconds left, clamped to 0..limit: a device clock that drifted
// behind the server must not show more time than the question has.
export function secondsLeft(startedAt, limit) {
  const deadline = deadlineMs(startedAt, limit)
  if (deadline == null) return null
  return Math.min(limit, Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
}
