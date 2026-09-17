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
