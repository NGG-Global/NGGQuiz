import { scalePoints } from '../lib/survey'

// A scale question: the points a participant taps, and the same strip the
// projected screen shows while the question is open. Only the two ends
// carry a name, which is how an agreement scale is normally written.
// Without onPick the strip is a display, not an input.
export default function Scale({ meta, onPick, chosen }) {
  const points = scalePoints(meta)
  if (!points.length) return null
  const Point = onPick ? 'button' : 'div'

  return (
    <div className="scale-strip" style={{ '--points': points.length }}>
      <div className="scale-row">
        {points.map((point, i) => (
          <Point
            key={point}
            className={`scale-point-btn${chosen === point ? ' chosen' : ''}`}
            style={{ '--i': i }}
            onClick={onPick ? () => onPick(point) : undefined}
          >
            {point}
          </Point>
        ))}
      </div>
      {(meta?.low_label || meta?.high_label) && (
        <div className="scale-ends-row">
          <span>{meta?.low_label}</span>
          <span>{meta?.high_label}</span>
        </div>
      )}
    </div>
  )
}
