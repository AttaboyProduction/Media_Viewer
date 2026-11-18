import { useEffect, useRef } from 'react'

export const KEYBOARD_RATING_WINDOW_MS = 2000

/** Resolve a digit press against an optional pending whole-star from the first key. */
export function scoreFromRatingDigit(
  digit: number,
  pendingWhole: number | null,
): { score: number; nextPending: number | null } {
  if (digit < 1 || digit > 5) {
    return { score: pendingWhole ?? 0, nextPending: pendingWhole }
  }
  if (pendingWhole == null) {
    return { score: digit, nextPending: digit }
  }
  if (digit === pendingWhole) {
    return { score: digit, nextPending: null }
  }
  if (digit > pendingWhole) {
    return { score: Math.min(5, pendingWhole + 0.5), nextPending: null }
  }
  // Lower digit starts a new whole-star rating.
  return { score: digit, nextPending: digit }
}

/**
 * While active, keys 1–5 rate the open media: first digit saves immediately;
 * a second digit within 2s can make N.5 (or restart on a lower digit).
 */
export function useKeyboardRating(
  enabled: boolean,
  mediaId: number,
  onRate: (score: number) => void,
) {
  const pendingWholeRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onRateRef = useRef(onRate)
  onRateRef.current = onRate

  useEffect(() => {
    pendingWholeRef.current = null
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [mediaId])

  useEffect(() => {
    if (!enabled) return

    const clearWindow = () => {
      pendingWholeRef.current = null
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (e.key < '1' || e.key > '5') return
      e.preventDefault()
      const digit = Number(e.key)
      const { score, nextPending } = scoreFromRatingDigit(digit, pendingWholeRef.current)
      onRateRef.current(score)
      pendingWholeRef.current = nextPending
      if (timerRef.current) clearTimeout(timerRef.current)
      if (nextPending != null) {
        timerRef.current = setTimeout(clearWindow, KEYBOARD_RATING_WINDOW_MS)
      } else {
        timerRef.current = null
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearWindow()
    }
  }, [enabled])
}
