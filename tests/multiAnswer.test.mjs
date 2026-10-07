// Reading and preparing answers that carry several values.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isMultiSelect,
  wordEntries,
  answerIndexes,
  answerTexts,
  optionCounts,
  cleanWords,
} from '../src/lib/multiAnswer.js'

test('question settings', () => {
  assert.equal(isMultiSelect({ qtype: 'poll', meta: { multi_select: true } }), true)
  assert.equal(isMultiSelect({ qtype: 'poll', meta: null }), false)
  // the flag means nothing on another type
  assert.equal(isMultiSelect({ qtype: 'multiple_choice', meta: { multi_select: true } }), false)
  assert.equal(wordEntries({ qtype: 'word_cloud', meta: { max_entries: 3 } }), 3)
  assert.equal(wordEntries({ qtype: 'word_cloud', meta: null }), 1)
  assert.equal(wordEntries({ qtype: 'word_cloud', meta: { max_entries: 99 } }), 5)
  assert.equal(wordEntries({ qtype: 'word_cloud', meta: { max_entries: 'x' } }), 1)
  assert.equal(wordEntries({ qtype: 'poll', meta: { max_entries: 3 } }), 1)
  assert.equal(wordEntries(null), 1)
})

test('both answer shapes are read', () => {
  assert.deepEqual(answerIndexes({ answer_index: 2, answer: null }), [2])
  assert.deepEqual(answerIndexes({ answer_index: null, answer: { indexes: [0, 3] } }), [0, 3])
  assert.deepEqual(answerIndexes({ answer_index: null, answer: null }), [])
  assert.deepEqual(answerTexts({ answer: { text: 'אמון' } }), ['אמון'])
  assert.deepEqual(answerTexts({ answer: { texts: ['אמון', ' ', 'trust'] } }), ['אמון', 'trust'])
  assert.deepEqual(answerTexts({ answer: null }), [])
})

test('option counts count each answer once per option, and only real options', () => {
  const answers = [
    { answer_index: 0 },
    { answer: { indexes: [0, 2] } },
    { answer: { indexes: [1, 1, 7, -1] } }, // a tampered client
  ]
  assert.deepEqual(optionCounts(answers, 3), [2, 1, 1])
  assert.deepEqual(optionCounts([], 2), [0, 0])
})

test('words are trimmed, de-duplicated and capped', () => {
  assert.deepEqual(cleanWords([' אמון ', 'Trust', 'trust', '', 'שקיפות', 'צמיחה'], 3), ['אמון', 'Trust', 'שקיפות'])
  assert.equal(cleanWords(['x'.repeat(60)], 1)[0].length, 40)
})
