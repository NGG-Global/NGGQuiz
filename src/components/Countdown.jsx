import { useEffect, useRef, useState } from 'react'

// Counts down from a server-side start timestamp; fires onDone once.
export default function Countdown({ startedAt, seconds, onDone }) {
  const endsAt = new Date(startedAt).getTime() + seconds * 1000
  const [left, setLeft] = useState(() => Math.max(0, endsAt - Date.now()))
  const doneFired = useRef(false)

  useEffect(() => {
    doneFired.current = false
    const timer = setInterval(() => {
      const remaining = Math.max(0, endsAt - Date.now())
      setLeft(remaining)
      if (remaining <= 0 && !doneFired.current) {
        doneFired.current = true
        clearInterval(timer)
        onDone?.()
      }
    }, 200)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, seconds])

  const secondsLeft = Math.ceil(left / 1000)
  return (
    <span className={`countdown ${secondsLeft <= 5 ? 'urgent' : ''}`}>
      {secondsLeft}
    </span>
  )
}
