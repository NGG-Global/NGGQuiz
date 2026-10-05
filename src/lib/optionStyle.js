// Up to seven answers per question. Each position keeps its own colour and
// shape across every screen (editor, projector, phone) so a player can match
// what they see on the wall with what they tap. The colours are mirrored by
// the .color-N classes in styles.css.
export const MAX_OPTIONS = 7
export const MIN_OPTIONS = 2
export const MIN_RANKING_OPTIONS = 3
export const DEFAULT_OPTIONS = 4

export const OPTION_COLORS = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#8e2de2', '#0d9488', '#f76707']
export const OPTION_SHAPES = ['▲', '◆', '●', '■', '★', '▼', '✦']

// True/false answers take blue and orange: neutral colours, so the wall never
// hints that green means "true" or red means "false" while the question is
// still open. Every other question keeps one colour per position.
const TRUE_FALSE_COLORS = [1, 6]

// The colour (and shape) index for option i - pair it with the .color-N
// classes and OPTION_SHAPES.
export function optionColor(question, i) {
  return question?.qtype === 'true_false' ? (TRUE_FALSE_COLORS[i] ?? i) : i
}

// The text shown for option i. True/false options are stored as interface
// strings and translated; written options are the author's own words and
// are shown exactly as typed.
export function optionLabel(question, i, t) {
  const opt = question?.options?.[i] ?? ''
  return question?.qtype === 'true_false' ? t(opt) : opt
}
