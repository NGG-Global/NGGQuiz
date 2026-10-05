// Splits an answer explanation into display blocks: a run of lines that
// start with a bullet marker becomes one list, any other line a paragraph,
// and blank lines are dropped.
//
// "-" and "*" count as markers only when a space follows, so "-5°C" or
// "*note*" stay plain text; "•" and "–" are never used any other way at the
// start of a line, so they count with or without the space.
const BULLET = /^(?:[-*]\s+|[•–]\s*)/

export function explanationBlocks(text) {
  const blocks = []
  String(text ?? '').split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()
    if (!line) return
    if (BULLET.test(line)) {
      const item = line.replace(BULLET, '').trim()
      if (!item) return
      const last = blocks[blocks.length - 1]
      if (last?.type === 'list') last.items.push(item)
      else blocks.push({ type: 'list', items: [item] })
    } else {
      blocks.push({ type: 'paragraph', text: line })
    }
  })
  return blocks
}
