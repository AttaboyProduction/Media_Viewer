/** One tilt fires several wheel events; treat them as a single left/right step. */
const WHEEL_NAV_LOCK_MS = 280
let wheelNavLockedUntil = 0

/**
 * Mouse-wheel tilt (the wheel click left or right). Vertical scrolling is ignored.
 * Positive deltaX is a right tilt (next), negative is a left tilt (previous).
 */
export function horizontalWheelDirection(deltaX: number, deltaY: number): 'prev' | 'next' | null {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null
  if (Math.abs(deltaX) < 8 || Math.abs(deltaX) <= Math.abs(deltaY)) return null
  return deltaX > 0 ? 'next' : 'prev'
}

function wheelAxisPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16
  if (deltaMode === 2) return delta * 400
  return delta
}

function isFieldTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

/**
 * If this wheel event is a left/right wheel tilt, consume it and return the
 * direction once per tilt. Later events in the same tilt return null.
 */
export function takeHorizontalWheelNav(event: WheelEvent): 'prev' | 'next' | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (isFieldTarget(event.target)) return null
  const direction = horizontalWheelDirection(
    wheelAxisPixels(event.deltaX, event.deltaMode),
    wheelAxisPixels(event.deltaY, event.deltaMode),
  )
  if (!direction) return null
  event.preventDefault()
  event.stopPropagation()
  const now = Date.now()
  if (now < wheelNavLockedUntil) return null
  wheelNavLockedUntil = now + WHEEL_NAV_LOCK_MS
  return direction
}
