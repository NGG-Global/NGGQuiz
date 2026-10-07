// Remembers which player this device joined as, per PIN.
//
// localStorage, not sessionStorage: a mobile browser that discarded the tab
// in the background, a closed and reopened browser, or a second scan of the
// QR code (which opens a new tab) must all come back as the same player -
// not as a second anonymous participant, and not as "this nickname is
// taken". sessionStorage is still read, for a phone that joined before.
//
// Every access is guarded: private modes and in-app browsers may refuse
// storage, and the game must still work there (a refresh then rejoins).

const PREFIX = 'nggquiz-player-'
// a PIN is only reused once its old session is deleted, and the restore
// checks the session anyway; the expiry just keeps old entries from piling up
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function stores() {
  const found = []
  try { if (window.localStorage) found.push(window.localStorage) } catch { /* refused */ }
  try { if (window.sessionStorage) found.push(window.sessionStorage) } catch { /* refused */ }
  return found
}

export function loadSavedPlayer(pin) {
  for (const store of stores()) {
    try {
      const saved = JSON.parse(store.getItem(PREFIX + pin) || 'null')
      if (!saved?.playerId || !saved?.sessionId) continue
      if (saved.savedAt && Date.now() - saved.savedAt > MAX_AGE_MS) continue
      return { playerId: saved.playerId, sessionId: saved.sessionId }
    } catch { /* corrupted entry - ignore it */ }
  }
  return null
}

export function savePlayer(pin, { playerId, sessionId }) {
  const value = JSON.stringify({ playerId, sessionId, savedAt: Date.now() })
  for (const store of stores()) {
    try {
      store.setItem(PREFIX + pin, value)
      return
    } catch { /* full or refused - try the next store */ }
  }
}

export function forgetPlayer(pin) {
  for (const store of stores()) {
    try { store.removeItem(PREFIX + pin) } catch { /* refused */ }
  }
}

// A player id chosen on the device rather than by the database, so a join
// retried after a lost response can tell its own earlier row (same id) from
// another player's (same nickname).
export function newPlayerId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
