import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

interface Props {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  className?: string
  /** Match the anchor width exactly (tag suggestions). */
  matchAnchorWidth?: boolean
  minWidth?: number
  maxWidth?: number
  onClickOutside?: () => void
}

/** Fixed popover on `document.body` — stays above overflow clipping and stacked UI. */
export default function FloatingPopover({
  open,
  anchorRef,
  children,
  className = '',
  matchAnchorWidth = false,
  minWidth = 280,
  maxWidth = 480,
  onClickOutside,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })

  useEffect(() => {
    if (!open || !onClickOutside) return

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClickOutside()
    }

    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, onClickOutside, anchorRef])

  useLayoutEffect(() => {
    if (!open) return

    const update = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const margin = 4
      const width = matchAnchorWidth
        ? rect.width
        : Math.min(maxWidth, Math.max(minWidth, rect.width, window.innerWidth - 16))
      let left = rect.left
      if (left + width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - width - 8)
      }

      const spaceBelow = window.innerHeight - rect.bottom - margin - 8
      const maxHeight = spaceBelow > 160 ? Math.min(22 * 16, spaceBelow) : undefined

      setStyle({
        position: 'fixed',
        left,
        top: rect.bottom + margin,
        width,
        maxHeight,
        overflowY: maxHeight ? 'auto' : undefined,
        visibility: 'visible',
      })
    }

    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, anchorRef, matchAnchorWidth, minWidth, maxWidth])

  if (!open) return null

  return createPortal(
    <div
      ref={popoverRef}
      className={`floating-popover${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children}
    </div>,
    document.body,
  )
}