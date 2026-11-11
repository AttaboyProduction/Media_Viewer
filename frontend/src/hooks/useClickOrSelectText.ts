import { useRef, type MouseEvent } from 'react'

const DRAG_THRESHOLD_PX = 4

/**
 * Clickable chips: allow click-drag text selection, but avoid highlight from
 * rapid / double clicks. Call from onMouseDown / onClick when the chip toggles.
 */
export function useClickOrSelectText() {
  const start = useRef<{ x: number; y: number } | null>(null)

  const onMouseDown = (e: MouseEvent) => {
    start.current = { x: e.clientX, y: e.clientY }
    // detail > 1 = 2nd+ click of a multi-click → browser would select the word
    if (e.detail > 1) e.preventDefault()
  }

  /** true when the pointer moved enough that this was a drag-select, not a click. */
  const isDragSelect = (e: MouseEvent) => {
    const from = start.current
    start.current = null
    if (!from) return false
    return Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_THRESHOLD_PX
  }

  const clearClickSelection = () => {
    window.getSelection()?.removeAllRanges()
  }

  return { onMouseDown, isDragSelect, clearClickSelection }
}
