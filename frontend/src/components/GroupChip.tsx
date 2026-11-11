import type { TagGroup } from '../types'
import { useClickOrSelectText } from '../hooks/useClickOrSelectText'

interface Props {
  group: TagGroup
  onRemove?: () => void
  onClick?: () => void
  small?: boolean
  clickable?: boolean
  title?: string
}

export default function GroupChip({
  group,
  onRemove,
  onClick,
  small,
  clickable,
  title,
}: Props) {
  const interactive = Boolean(onClick || clickable)
  const pointer = useClickOrSelectText()

  return (
    <span
      className={`group-chip${small ? ' group-chip-small' : ''}${interactive ? ' group-chip-clickable' : ''}`}
      style={{ backgroundColor: group.default_color }}
      title={title ?? group.key}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation()
              if (pointer.isDragSelect(e)) return
              pointer.clearClickSelection()
              onClick()
            }
          : undefined
      }
      onMouseDown={onClick ? pointer.onMouseDown : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              onClick()
            }
          : undefined
      }
    >
      {group.label}
      {onRemove && (
        <button
          type="button"
          className="group-chip-remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          ×
        </button>
      )}
    </span>
  )
}
