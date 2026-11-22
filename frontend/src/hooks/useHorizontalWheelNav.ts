import { useEffect, useRef, type RefObject } from 'react'
import { takeHorizontalWheelNav } from '../utils/horizontalWheelNav'

/** Wheel-tilt previous/next on `ref`. Listener is non-passive so the tilt does not scroll. */
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
}
