// Fitting the projector screen to the window, and stepping it with Enter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitScale, advanceAction, isAdvanceKey, MIN_FIT_SCALE } from '../src/lib/projector.js'

test('content that fits is left at full size', () => {
  assert.equal(fitScale(600, 1000), 1)
  assert.equal(fitScale(1000, 1000), 1)
  // nothing measured yet
  assert.equal(fitScale(0, 1000), 1)
  assert.equal(fitScale(800, 0), 1)
})

test('taller content is scaled down, never past the window', () => {
  assert.equal(fitScale(1200, 1000), 0.83)
  assert.equal(fitScale(2000, 1000), 0.5)
  for (const natural of [1001, 1234, 1567, 1999]) {
    const scale = fitScale(natural, 1000)
    assert.ok(scale * natural <= 1000, `${natural} at ${scale}`)
  }
})

test('below the readable floor the screen scrolls instead', () => {
  assert.equal(fitScale(2100, 1000), null)
  assert.equal(fitScale(5000, 1000), null)
  assert.equal(fitScale(1500, 1000, 0.7), null)
  assert.ok(MIN_FIT_SCALE > 0 && MIN_FIT_SCALE < 1)
})

test('Enter follows the main button of each screen', () => {
  assert.equal(advanceAction({ status: 'lobby', players: 0, isLast: false }), null)
  assert.equal(advanceAction({ status: 'lobby', players: 3, isLast: false }), 'start')
  assert.equal(advanceAction({ status: 'question', players: 3, isLast: false }), 'reveal')
  assert.equal(advanceAction({ status: 'question', players: 3, isLast: true }), 'reveal')
  assert.equal(advanceAction({ status: 'reveal', players: 3, isLast: false }), 'next')
  assert.equal(advanceAction({ status: 'reveal', players: 3, isLast: true }), 'finish')
  assert.equal(advanceAction({ status: 'leaderboard', players: 3, isLast: false }), 'next')
  assert.equal(advanceAction({ status: 'leaderboard', players: 3, isLast: true }), 'finish')
  assert.equal(advanceAction({ status: 'finished', players: 3, isLast: true }), null)
})

test('only a plain, deliberate Enter counts', () => {
  const body = { closest: () => null }
  const button = { closest: (sel) => (sel.includes('button') ? button : null) }
  const press = (over) => ({ key: 'Enter', target: body, ...over })
  assert.equal(isAdvanceKey(press()), true)
  assert.equal(isAdvanceKey(press({ key: ' ' })), false)
  assert.equal(isAdvanceKey(press({ repeat: true })), false)
  assert.equal(isAdvanceKey(press({ defaultPrevented: true })), false)
  assert.equal(isAdvanceKey(press({ ctrlKey: true })), false)
  assert.equal(isAdvanceKey(press({ shiftKey: true })), false)
  assert.equal(isAdvanceKey(press({ isComposing: true })), false)
  // a focused button answers Enter itself
  assert.equal(isAdvanceKey(press({ target: button })), false)
  // the document itself as the target
  assert.equal(isAdvanceKey(press({ target: {} })), true)
})
