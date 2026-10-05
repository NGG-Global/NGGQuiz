// How a quiz row runs, worked out in one place so every screen agrees.
//
//   survey     kind = 'survey': unscored scale and choice questions that end
//              in aggregate statistics
//   scored     an ordinary quiz: points, leaderboard and podium
//   live       a quiz with scored = false ("live mode"): no points, results
//              rise on the projector while the question is open, and the
//              reveal shows an answer slide instead of a ranking
//   anonymous  participants join without a nickname; only in live mode,
//              since a leaderboard needs names
//
// Rows written before live mode existed carry no scored or anonymous value,
// so anything other than an explicit false / true reads as today's
// behaviour: scored, with nicknames.
export function quizFlags(quiz) {
  const survey = quiz?.kind === 'survey'
  const scored = !survey && quiz?.scored !== false
  const live = !survey && !scored
  const anonymous = live && quiz?.anonymous === true
  return { survey, scored, anonymous, live }
}

// Question types whose results rise on the projector while a live question
// is open: written options a phone taps once.
export const LIVE_BAR_TYPES = ['true_false', 'multiple_choice', 'poll']

// Question types revealed with the live answer slide: one correct option.
export const ANSWER_SLIDE_TYPES = ['true_false', 'multiple_choice']
