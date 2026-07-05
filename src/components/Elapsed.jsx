import { useEffect, useState } from 'react'

// Counts up from a server-side start timestamp (m:ss).
export default function Elapsed({ since }) {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const start = new Date(since).getTime()
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)))
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [since])

  const m = Math.floor(seconds / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return <span className="elapsed">{m}:{s}</span>
}
