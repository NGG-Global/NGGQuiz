// Builds absolute links that work both locally and under a GitHub Pages sub-path
export function appLink(hashPath) {
  return `${window.location.origin}${window.location.pathname}#${hashPath}`
}

export function hostLink(sessionId) {
  return appLink(`/host/${sessionId}`)
}

export function playLink(pin) {
  return appLink(`/play/${pin}`)
}
