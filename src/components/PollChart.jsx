import { OPTION_SHAPES } from '../lib/optionStyle'
import { normalReference } from '../lib/stats'
import { useI18n } from '../lib/i18n.js'

// headroom (in viewBox units) that keeps the curve's stroke inside the plot
const TOP_PAD = 4

// Survey results: one bar per option, drawn against a faint normal curve
// fitted to the same answers. Both share a single axis, so the gap between
// them is the real gap between the room's answers and a normal distribution;
// neither is rescaled to make the other look better.
export default function PollChart({ options, counts }) {
  const { t } = useI18n()
  const total = counts.reduce((sum, c) => sum + c, 0)
  const reference = normalReference(counts)
  const top = Math.max(1, ...counts, reference?.peak ?? 0)

  // share of the plot height, as a percentage, for a given answer count
  const plotHeight = (value) => (value / top) * (100 - TOP_PAD)

  // The curve is drawn in a 100x100 viewBox stretched over the plot area, so
  // option i sits at the centre of its column. In RTL the columns run the
  // other way and the stylesheet mirrors the whole overlay to match.
  const curve = reference
    ? reference.points
        .map(({ x, y }, i) => {
          const px = ((x + 0.5) / options.length) * 100
          const py = 100 - plotHeight(y)
          return `${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`
        })
        .join(' ')
    : null

  return (
    <div className="poll-chart" style={{ '--bars': options.length }}>
      <div className="poll-plot">
        <div className="poll-cols">
          {options.map((opt, i) => {
            const count = counts[i] || 0
            return (
              <div
                className="poll-col"
                style={{ '--i': i }}
                key={i}
                title={`${opt} - ${t('{count} תשובות', { count })}`}
              >
                <span className="poll-value">
                  <strong>{total ? Math.round((count / total) * 100) : 0}%</strong>
                  <span className="poll-count">{count}</span>
                </span>
                <div className={`poll-bar color-${i}`} style={{ height: `${plotHeight(count)}%` }} />
              </div>
            )
          })}
        </div>
        {curve && (
          <div className="poll-curve">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path d={curve} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        )}
      </div>

      <div className="poll-labels">
        {options.map((opt, i) => (
          <div className="poll-label" style={{ '--i': i }} key={i}>
            <span className={`poll-shape color-${i}`}>{OPTION_SHAPES[i]}</span>
            <span className="poll-text">{opt}</span>
          </div>
        ))}
      </div>

      <p className="poll-caption">
        {total ? (
          t('{count} תשובות', { count: total })
        ) : (
          <span className="waiting-dots">{t('ממתינים לתשובות...')}</span>
        )}
        {reference && (
          <span className="poll-legend">
            <span className="poll-legend-line" aria-hidden="true" />
            {t('עקומת ייחוס: התפלגות נורמלית סביב אפשרות {mean} (סטיית תקן {sd})', {
              mean: (reference.mean + 1).toFixed(1),
              sd: reference.sd.toFixed(1),
            })}
          </span>
        )}
      </p>
    </div>
  )
}
