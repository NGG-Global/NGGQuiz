// Questions a participant may answer with more than one value: a poll whose
// author allowed several options, and a word cloud that takes several words.
//
// Each participant still sends ONE answer row per question (the database
// keeps one per player), so the "answered" counts stay counts of people:
//   poll, several options    answer = { indexes: [0, 2] }, answer_index null
//   word cloud, several words answer = { texts: ['אמון', 'שקיפות'] }
// The settings live on the question's meta:
//   poll        meta.multi_select = true
//   word cloud  meta.max_entries  = 2..5 (absent: one word, as before)
// A single answer keeps its original shape (answer_index / answer.text),
// so everything below reads both.
//
// Plain JavaScript with no build-time imports: the load simulator uses it too.

export const WORD_ENTRY_CHOICES = [2, 3, 4, 5]
export const DEFAULT_WORD_ENTRIES = 3
// the phone's limit per word; the database allows a little more
export const MAX_WORD_LENGTH = 40

export function isMultiSelect(question) {
  return question?.qtype === 'poll' && question?.meta?.multi_select === true
}

// How many words a participant may send to a word cloud question.
export function wordEntries(question) {
  if (question?.qtype !== 'word_cloud') return 1
  const n = Number(question?.meta?.max_entries)
  if (!Number.isInteger(n) || n < 2) return 1
  return Math.min(n, WORD_ENTRY_CHOICES[WORD_ENTRY_CHOICES.length - 1])
}

// The options one answer chose, in either shape.
export function answerIndexes(answer) {
  if (Array.isArray(answer?.answer?.indexes)) return answer.answer.indexes
  return answer?.answer_index == null ? [] : [answer.answer_index]
}

// The words one answer sent, in either shape.
export function answerTexts(answer) {
  if (Array.isArray(answer?.answer?.texts)) return answer.answer.texts.filter((w) => typeof w === 'string' && w.trim())
  return typeof answer?.answer?.text === 'string' && answer.answer.text.trim() ? [answer.answer.text] : []
}

// How many answers chose each option. An option counts once per answer, and
// an index outside the options (a tampered client) counts nowhere.
export function optionCounts(answers, optionCount) {
  const counts = Array(optionCount).fill(0)
  for (const answer of answers) {
    for (const i of new Set(answerIndexes(answer))) {
      if (Number.isInteger(i) && i >= 0 && i < optionCount) counts[i] += 1
    }
  }
  return counts
}

// The words a participant is about to send: trimmed, empty ones dropped,
// and the same word (ignoring case) kept once.
export function cleanWords(words, max) {
  const seen = new Set()
  const out = []
  for (const raw of words) {
    const word = String(raw ?? '').trim().slice(0, MAX_WORD_LENGTH)
    const key = word.toLowerCase()
    if (!word || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length >= max) break
  }
  return out
}
