import { OPTION_SHAPES } from '../lib/optionStyle'
import { normalReference } from '../lib/stats'
import { useI18n } from '../lib/i18n.js'

// headroom (in viewBox units) that keeps the curve's stroke inside the plot
const TOP_PAD = 4

// Survey results: one bar per option, drawn against a faint normal curve
// fitted to the same answers. Both share a single axis, so the gap between
// them is the real gap between the room's answers and a normal distribution;
// neither is rescaled to make the other look better.
//
// With `scale` the bars are the points of a scale question rather than
// written options: they share one accent colour instead of the per-option
// colours and shapes, since the points are an ordered run, not a set of
// separate choices.
//
// `reference` turns the curve off. A normal distribution only means
// something across answers that have an order, so a survey's choice
// questions - where the options are just different answers, in no
// particular order - are drawn without it.
//
// `correctIndex` marks the right answer once it is revealed: its bar turns
// green with a ✓ under it and the others are muted. Leave it null while a
// question is open, or the chart gives the answer away.
//
// `colorIndexes` replaces the colour (and shape) of each bar, so a chart
// matches the tiles a phone shows (true/false answers are blue and orange,
// not the first two option colours).
//
// `live` is for a chart that stays mounted while answers stream in: the bars
// ease to each new height instead of jumping, since the rise animation only
// plays once, on mount.
export default function PollChart({
  options,
  counts,
  scale = false,
  reference: withReference = true,
  correctIndex = null,
  colorIndexes = null,
  live = false,
}) {
  const { t } = useI18n()
  const colorOf = (i) => colorIndexes?.[i] ?? i
  const judged = correctIndex != null
  const verdict = (i) => (judged ? (i === correctIndex ? ' correct' : ' wrong') : '')
  const total = counts.reduce((sum, c) => sum + c, 0)
  const reference = withReference ? normalReference(counts) : null
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
    <div className={`poll-chart${live ? ' live' : ''}`} style={{ '--bars': options.length }}>
      <div className="poll-plot">
        <div className="poll-cols">
          {options.map((opt, i) => {
            const count = counts[i] || 0
            return (
              <div
                className={`poll-col${verdict(i)}`}
                style={{ '--i': i }}
                key={i}
                title={`${opt} - ${t('{count} תשובות', { count })}`}
              >
                <span className="poll-value">
                  <strong>{total ? Math.round((count / total) * 100) : 0}%</strong>
                  <span className="poll-count">{count}</span>
                </span>
                <div
                  className={`poll-bar ${scale ? 'scale' : `color-${colorOf(i)}`}${verdict(i)}`}
                  style={{ height: `${plotHeight(count)}%` }}
                />
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
          <div className={`poll-label${verdict(i)}`} style={{ '--i': i }} key={i}>
            {!scale && <span className={`poll-shape color-${colorOf(i)}`}>{OPTION_SHAPES[colorOf(i)]}</span>}
            <span className={scale ? 'poll-text scale-value' : 'poll-text'}>
              {opt}{judged && i === correctIndex && ' ✓'}
            </span>
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
