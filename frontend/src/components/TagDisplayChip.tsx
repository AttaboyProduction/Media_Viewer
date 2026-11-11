import type { MediaTag, Tag } from '../types'
import TagChip, { type TagChipData } from './TagChip'

interface Props {
  tag: MediaTag | Tag
  onClick?: () => void
  onRemove?: () => void
  active?: boolean
}

export default function TagDisplayChip({ tag, onClick, onRemove, active }: Props) {
  const names =
    'display_names' in tag && tag.display_names?.length
      ? tag.display_names
      : [tag.name]

  if (names.length <= 1) {
    const chipTag: TagChipData = {
      name: names[0],
      color: tag.color,
      group: tag.group,
      is_manual: 'is_manual' in tag ? tag.is_manual : false,
    }
    return (
      <TagChip
        tag={chipTag}
        onClick={onClick}
        onRemove={onRemove}
        active={active}
      />
    )
  }

  return (
    <span className="tag-display-group">
      {names.map((name) => (
        <TagChip
          key={`${tag.id}-${name}`}
          tag={{
            name,
            color: tag.color,
            group: tag.group,
            is_manual: 'is_manual' in tag ? tag.is_manual : false,
          }}
          onClick={onClick}
          active={active}
        />
      ))}
      {onRemove && (
        <button type="button" className="tag-display-remove" onClick={onRemove} aria-label="Remove tag">
          ×
        </button>
      )}
    </span>
  )
}
