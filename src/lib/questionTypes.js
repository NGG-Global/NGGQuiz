export const QUESTION_TYPES = [
  { value: 'multiple_choice', label: 'רב-ברירה', icon: '✅' },
  { value: 'poll', label: 'סקר (ללא תשובה נכונה)', icon: '📊' },
  { value: 'word_cloud', label: 'ענן מילים', icon: '☁️' },
  { value: 'ranking', label: 'סדר נכון', icon: '🔢' },
  { value: 'hotspot', label: 'נקודה על תמונה', icon: '🎯' },
  { value: 'true_false', label: 'נכון / לא נכון', icon: '⚖️' },
]

// The two answers a true/false question always stores. Like every other
// interface string they are kept in Hebrew and translated where they are
// shown (optionLabel), so a question reads correctly in either language.
export const TRUE_FALSE_OPTIONS = ['נכון', 'לא נכון']

// Question types with written options and exactly one correct option.
export function hasCorrectOption(qtype) {
  return qtype === 'multiple_choice' || qtype === 'true_false'
}

export const TEAM_COLORS = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#8e2de2', '#0d9488']

export function teamColor(quiz, teamName) {
  const idx = (quiz?.teams || []).indexOf(teamName)
  return TEAM_COLORS[(idx >= 0 ? idx : 0) % TEAM_COLORS.length]
}

export function shuffled(n) {
  const arr = Array.from({ length: n }, (_, i) => i)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// number of inversions = Kendall distance from the correct order (0..n-1)
export function kendallSimilarity(order) {
  const n = order.length
  if (n < 2) return 1
  let d = 0
  for (let i = 0; i < n - 1; i++)
    for (let j = i + 1; j < n; j++)
      if (order[i] > order[j]) d++
  return 1 - d / ((n * (n - 1)) / 2)
}
