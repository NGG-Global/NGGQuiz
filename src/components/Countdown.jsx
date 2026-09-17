import { useEffect, useState } from 'react'
import { secondsLeft } from '../lib/timer'

// Ticks down to a timed question's deadline. Returns null when there is
// no limit, so callers can fall back to the elapsed-time display. The
// value is derived on every render, so it is never a question behind.
export function useSecondsLeft(startedAt, limit) {
  const [, tick] = useState(0)

  useEffect(() => {
    if (!startedAt || !limit) return
    const timer = setInterval(() => {
      tick((n) => n + 1)
      if (secondsLeft(startedAt, limit) === 0) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [startedAt, limit])

  return secondsLeft(startedAt, limit)
}

// Shows the remaining time as m:ss, flashing over the last few seconds.
export default function Countdown({ left }) {
  const m = Math.floor(left / 60)
  const s = String(left % 60).padStart(2, '0')
  return (
    <span className={`elapsed countdown${left <= 5 ? ' urgent' : ''}`}>
      ⏱ {m}:{s}
    </span>
  )
}
