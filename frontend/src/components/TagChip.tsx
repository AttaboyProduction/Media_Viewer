import type { TagGroup } from '../types'
import { useClickOrSelectText } from '../hooks/useClickOrSelectText'
import { decodeHtmlEntities } from '../utils/htmlEntities'

export interface TagChipData {
  name: string
  color: string
  group?: TagGroup | null
  display_names?: string[]
  is_manual?: boolean
}

interface Props {
  tag: TagChipData
  onClick?: () => void
  onRemove?: () => void
  active?: boolean
  className?: string
}

export default function TagChip({ tag, onClick, onRemove, active, className }: Props) {
  const pointer = useClickOrSelectText()

  return (
    <span
      className={['tag-chip', active ? 'filter-active' : '', className].filter(Boolean).join(' ')}
      style={{ backgroundColor: tag.color, cursor: onClick ? 'pointer' : undefined }}
      onClick={
        onClick
          ? (e) => {
              // Drag-select: keep the highlight, don't toggle.
              if (pointer.isDragSelect(e)) return
              pointer.clearClickSelection()
              onClick()
            }
          : undefined
      }
      onMouseDown={onClick ? pointer.onMouseDown : undefined}
      title={tag.group?.label ?? (onClick ? undefined : 'unknown')}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      {decodeHtmlEntities(tag.name)}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{
            marginLeft: 4,
            background: 'transparent',
            border: 'none',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      )}
    </span>
  )
}
