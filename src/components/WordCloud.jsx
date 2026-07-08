import { useMemo } from 'react'

const CLOUD_COLORS = ['#ffd166', '#7cf5a1', '#8ecbff', '#ff9ccd', '#c9a7ff', '#ffb28b', '#ffffff']

// Live word cloud: aggregates identical answers and scales them by
// frequency. Each new word pops in as answers stream in.
export default function WordCloud({ texts, empty = 'ממתינים לתשובות...' }) {
  const entries = useMemo(() => {
    const counts = new Map()
    texts.forEach((raw) => {
      const key = String(raw || '').trim().toLowerCase()
      if (!key) return
      const cur = counts.get(key)
      if (cur) cur.count += 1
      else counts.set(key, { display: String(raw).trim(), count: 1 })
    })
    return [...counts.values()].sort((a, b) => b.count - a.count)
  }, [texts])

  if (entries.length === 0) return <p className="waiting-dots">{empty}</p>

  const max = entries[0].count
  return (
    <div className="word-cloud">
      {entries.map((e, i) => (
        <span
          key={e.display.toLowerCase()}
          className="cloud-word"
          style={{
            fontSize: `${1 + (e.count / max) * 2.4}rem`,
            color: CLOUD_COLORS[i % CLOUD_COLORS.length],
            opacity: 0.65 + 0.35 * (e.count / max),
          }}
          title={`${e.count} תשובות`}
        >
          {e.display}
        </span>
      ))}
    </div>
  )
}
