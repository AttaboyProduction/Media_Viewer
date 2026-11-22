import { useEffect, useRef, type RefObject } from 'react'
import { takeHorizontalWheelNav } from '../utils/horizontalWheelNav'
import { shouldSkipKeyboardShortcut } from '../utils/keyboardTarget'

/**
 * Wheel-tilt and ←/→ previous/next on `ref` (and document for keys).
 * Wheel listener is non-passive so the tilt does not scroll.
 * Keys use bubble phase so a capture-phase detail modal can own ←/→ first.
 */
export function useHorizontalWheelNav(
  ref: RefObject<HTMLElement | null>,
  onDirection: (direction: 'prev' | 'next') => void,
  enabled = true,
) {
  const onDirectionRef = useRef(onDirection)
  onDirectionRef.current = onDirection

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const onWheel = (event: WheelEvent) => {
      const direction = takeHorizontalWheelNav(event)
      if (direction) onDirectionRef.current(direction)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, enabled])

  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (shouldSkipKeyboardShortcut(event)) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      onDirectionRef.current(event.key === 'ArrowLeft' ? 'prev' : 'next')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
