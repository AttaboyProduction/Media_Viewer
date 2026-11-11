import type { ReactNode, MouseEvent } from 'react'

import { useContentHide } from '../hooks/useContentHide'
import type { MediaItem } from '../types'

type Props = {
  item: MediaItem
  children: ReactNode
  className?: string
  /** When true, overlay click does not stopPropagation (card open handlers). */
  allowBubble?: boolean
  /**
   * When false (e.g. Select / Add related), keep the blur but let clicks pass through
   * so selection wins over “Show hidden content”.
   */
  revealOnClick?: boolean
}

/** Wraps media with a blur overlay while content-hide rules lock the item. */
export default function ContentHideMedia({
  item,
  children,
  className = '',
  allowBubble = false,
  revealOnClick = true,
}: Props) {
  const { isLocked, revealForMedia, revealing } = useContentHide()
  const locked = isLocked(item)

  const onReveal = (e: MouseEvent) => {
    if (!allowBubble) {
      e.preventDefault()
      e.stopPropagation()
    }
    if (revealing) return
    void revealForMedia(item)
  }

  return (
    <div
      className={`content-hide-media${locked ? ' content-hide-locked' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
      {locked &&
        (revealOnClick ? (
          <button
            type="button"
            className="content-hide-overlay"
            onClick={onReveal}
            disabled={revealing}
            aria-label="Show hidden content"
          >
            <span className="content-hide-overlay-label">Show hidden content</span>
          </button>
        ) : (
          <div className="content-hide-overlay content-hide-overlay-passive" aria-hidden="true">
            <span className="content-hide-overlay-label">Hidden content</span>
          </div>
        ))}
    </div>
  )
}
