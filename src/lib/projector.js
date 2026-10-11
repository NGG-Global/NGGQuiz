// The projector screen fits itself to the window, and the host can step the
// game forward from the keyboard. Both decisions live here, free of React and
// the DOM, so they can be tested on their own.

// Below this the projected text is too small to read from the hall, so the
// screen scrolls instead (a long final summary, a lobby wall of hundreds of
// names). Enter still moves the game on when the button is out of view.
export const MIN_FIT_SCALE = 0.5

// The factor that fits content of a given natural height into the space the
// window offers: 1 when it already fits, null when fitting would shrink it
// below the floor. Rounded down, so a rounded factor never overflows by a pixel.
export function fitScale(natural, available, min = MIN_FIT_SCALE) {
  if (!(natural > 0) || !(available > 0) || natural <= available) return 1
  const scale = Math.floor((available / natural) * 100) / 100
  return scale < min ? null : scale
}

// What Enter does on the projector: the screen's main button, nothing else.
// The secondary "leaderboard" button stays a click, so a key press can never
// open a screen the host did not mean to show.
export function advanceAction({ status, players, isLast }) {
  switch (status) {
    case 'lobby':
      return players > 0 ? 'start' : null
    case 'question':
      return 'reveal'
    case 'reveal':
    case 'leaderboard':
      return isLast ? 'finish' : 'next'
    default:
      return null
  }
}

// A step taken this recently is not followed by another from the keyboard: two
// quick presses must not open a question and reveal its answer before anyone
// in the room has read it.
export const ADVANCE_COOLDOWN_MS = 1000

// Whether a keydown is a deliberate "advance" press. A held key repeats, and a
// focused control (a button, a field) already answers Enter on its own, so
// handling it here as well would act twice.
export function isAdvanceKey(event) {
  if (event.key !== 'Enter' || event.repeat || event.defaultPrevented) return false
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return false
  const target = event.target
  return !(target?.closest?.('button, a, input, textarea, select, [contenteditable]'))
}
