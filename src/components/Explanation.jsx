import { explanationBlocks } from '../lib/explanation'

// An answer explanation as the author wrote it. Every block is rendered as
// a React text node, never as HTML, so whatever was typed in the editor is
// shown as text and cannot inject markup. Lines that start with a bullet
// marker become a list (see explanationBlocks).
//
// `lead` (an emoji, say) opens the first paragraph; when the explanation
// opens with a list instead, it gets a line of its own.
export default function Explanation({ text, lead = null, className = '' }) {
  const blocks = explanationBlocks(text)
  if (!blocks.length) return null
  const leadInline = lead != null && blocks[0].type === 'paragraph'

  return (
    <div className={`explanation${className ? ` ${className}` : ''}`}>
      {lead != null && !leadInline && <span className="explanation-lead">{lead}</span>}
      {blocks.map((block, i) =>
        block.type === 'list' ? (
          <ul key={i}>
            {block.items.map((item, j) => <li key={j}>{item}</li>)}
          </ul>
        ) : (
          <p key={i}>{i === 0 && leadInline ? <>{lead} </> : null}{block.text}</p>
        )
      )}
    </div>
  )
}
