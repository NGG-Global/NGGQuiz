import { useLayoutEffect, useRef, useState } from 'react'
import { fitScale } from './projector.js'

// Keeps a screen's content within the window: when it is taller than the
// window it is scaled down as a whole, so the host's button is always in
// view. Returns refs for the screen and for its content, and the scale -
// null when even the smallest readable scale is too tall, in which case the
// screen scrolls as before.
//
// The content is measured at its natural size (the CSS `scale` property does
// not change layout), so applying a scale never feeds back into the next
// measurement. It is re-measured whenever the content changes size (players
// joining, answers arriving, an image loading) and whenever the window does
// (a resize, entering full screen).
export function useFitToScreen(ready) {
  const stageRef = useRef(null)
  const contentRef = useRef(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const stage = stageRef.current
    const content = contentRef.current
    if (!ready || !stage || !content) return
    let frame = 0

    function measure() {
      frame = 0
      const style = getComputedStyle(stage)
      const available =
        document.documentElement.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      setScale(fitScale(content.offsetHeight, available))
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure)
    }

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(content)
    window.addEventListener('resize', schedule)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [ready])

  return { stageRef, contentRef, scale }
}
