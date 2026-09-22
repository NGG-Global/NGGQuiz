// Descriptive statistics for a survey distribution.
//
// Each answer to option i counts as one observation with the value i, so a
// survey whose options run on a scale ("never" → "always", 1 → 5) can be
// compared with the normal distribution that shares its mean and standard
// deviation. The comparison only carries meaning when the options are
// ordered; for unordered categories the curve is a visual reference and
// nothing more.

// A normal reference says nothing below these thresholds, so it is dropped:
// two options cannot show a shape, a handful of answers is noise, and a
// standard deviation near zero means everyone picked the same option.
const MIN_OPTIONS = 3
const MIN_ANSWERS = 5
const MIN_SD = 0.5
// It is dropped above this one too: a fitted curve that peaks well over the
// tallest bar cannot describe the answers (they sit in fewer options than
// that spread implies, as with unordered choices such as yes / no / other),
// and drawing it would both mislead and squash the bars it is measured
// against.
const MAX_PEAK_RATIO = 1.25

export function distributionStats(counts) {
  const total = counts.reduce((sum, c) => sum + c, 0)
  if (!total) return null
  const mean = counts.reduce((sum, c, i) => sum + c * i, 0) / total
  const variance = counts.reduce((sum, c, i) => sum + c * (i - mean) ** 2, 0) / total
  return { total, mean, sd: Math.sqrt(variance) }
}

// The answer counts a normal distribution with the same mean and standard
// deviation would have produced, sampled along the option axis so the line
// can be drawn smoothly. Returns null when the reference is not meaningful.
export function normalReference(counts, samples = 72) {
  const stats = distributionStats(counts)
  if (!stats) return null
  if (counts.length < MIN_OPTIONS || stats.total < MIN_ANSWERS || stats.sd < MIN_SD) return null

  const { total, mean, sd } = stats
  // expected count per option-wide bin: N · φ((x − μ) / σ) / σ
  const expectedAt = (x) =>
    (total * Math.exp(-((x - mean) ** 2) / (2 * sd * sd))) / (sd * Math.sqrt(2 * Math.PI))

  // the mean always falls inside [0, last], so the curve peaks there
  const peak = expectedAt(mean)
  if (peak > Math.max(...counts) * MAX_PEAK_RATIO) return null

  const last = counts.length - 1
  const points = Array.from({ length: samples + 1 }, (_, k) => {
    const x = (k / samples) * last
    return { x, y: expectedAt(x) }
  })
  return { ...stats, points, peak }
}

// ---------- survey statistics ----------
//
// A scale question's answers are the points participants chose, so unlike
// the option indices above they carry real numeric meaning and the whole
// summary is reported: mean, median, the most frequent answer, spread and
// the count behind them.
//
// Reading a mean off an agreement scale treats ordered labels as if the
// distance between them were equal, which is convention rather than fact -
// which is why the median and the mode are shown beside it, and why the
// distribution itself is always on screen.

// counts[i] is how many participants chose the value min + i.
export function scaleSummary(counts, min, max) {
  const n = counts.reduce((sum, c) => sum + c, 0)
  if (!n) return null

  const value = (i) => min + i
  const mean = counts.reduce((sum, c, i) => sum + c * value(i), 0) / n
  const variance = counts.reduce((sum, c, i) => sum + c * (value(i) - mean) ** 2, 0) / n

  // the value of the k-th answer (0-based) once they are lined up in order
  const at = (k) => {
    let seen = 0
    for (let i = 0; i < counts.length; i++) {
      seen += counts[i]
      if (seen > k) return value(i)
    }
    return value(counts.length - 1)
  }
  // with an even number of answers the median sits between the middle two
  const median = (at(Math.floor((n - 1) / 2)) + at(Math.ceil((n - 1) / 2))) / 2

  const top = Math.max(...counts)
  const modes = counts.map((c, i) => (c === top ? value(i) : null)).filter((v) => v !== null)

  return {
    n,
    mean,
    median,
    modes,
    sd: Math.sqrt(variance),
    // position on the scale as a 0-100 index, so questions that run on
    // different scales can still be compared and combined
    index: ((mean - min) / (max - min)) * 100,
  }
}

// One headline number for a survey: the average of each scale question's
// 0-100 index. Questions count equally, whatever their scale or how many
// people answered them.
export function overallIndex(summaries) {
  const scored = summaries.filter(Boolean)
  if (!scored.length) return null
  return scored.reduce((sum, s) => sum + s.index, 0) / scored.length
}
