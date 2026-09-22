// Surveys: unscored questionnaires that end in aggregate statistics
// instead of a podium. A survey asks two kinds of question - a scale, or
// a plain choice between written options (the same question the quiz
// calls a poll).

export const SCALE_PRESETS = [
  { min: 1, max: 5 },
  { min: 1, max: 7 },
  { min: 0, max: 10 },
]

export const DEFAULT_SCALE = { min: 1, max: 5, low_label: '', high_label: '' }

export const SURVEY_TYPES = [
  { value: 'scale', label: 'שאלת סולם', icon: '📏' },
  { value: 'poll', label: 'בחירה מרובה (ללא סולם)', icon: '📊' },
]

export function isSurvey(quiz) {
  return quiz?.kind === 'survey'
}

// The points of a scale question, e.g. [1, 2, 3, 4, 5].
export function scalePoints(meta) {
  const min = Number(meta?.min ?? DEFAULT_SCALE.min)
  const max = Number(meta?.max ?? DEFAULT_SCALE.max)
  if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) return []
  return Array.from({ length: max - min + 1 }, (_, i) => min + i)
}

// How many participants chose each point of the scale. A scale answer
// stores the chosen value itself in answer_index.
export function scaleCounts(answers, meta) {
  const points = scalePoints(meta)
  const counts = points.map(() => 0)
  answers.forEach((a) => {
    const i = points.indexOf(a.answer_index)
    if (i >= 0) counts[i] += 1
  })
  return counts
}

// The label under a scale point: only the two ends are named, which is
// how an agreement scale is normally written (1 = לא מסכים, 5 = מסכים).
export function scalePointLabel(meta, value) {
  const points = scalePoints(meta)
  if (value === points[0]) return meta?.low_label || ''
  if (value === points[points.length - 1]) return meta?.high_label || ''
  return ''
}
