import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MediaTag } from '../types'
import { registerEscapeHandler } from '../utils/escapeStack'
import { COLLAPSED_CHIP_RENDER_LIMIT, TWO_LINE_MAX_HEIGHT } from '../utils/tagSort'
import TagDisplayChip from './TagDisplayChip'

interface Props {
  tags: MediaTag[]
  onTagClick?: (name: string) => void
  activeNames?: string[]
  emptyMessage?: string
  /** Selected tags shown above the list (panel display mode). */
  selectedPanelTags?: MediaTag[]
  /** Controlled expand so parent can keep it across media refetches. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

export default function CollapsibleTagChipList({
  tags,
  onTagClick,
  activeNames = [],
  emptyMessage = 'No tags match',
  selectedPanelTags = [],
  expanded: expandedProp,
  onExpandedChange,
}: Props) {
  const [expandedLocal, setExpandedLocal] = useState(false)
  const controlled = onExpandedChange != null
  const expanded = controlled ? Boolean(expandedProp) : expandedLocal
  const [canCollapse, setCanCollapse] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const setExpanded = (next: boolean) => {
    if (controlled) onExpandedChange!(next)
    else setExpandedLocal(next)
  }

  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el || tags.length === 0) {
      if (!expanded) setCanCollapse(false)
      return
    }
    if (expanded) {
      setCanCollapse(true)
      return
    }
    setCanCollapse(
      tags.length > COLLAPSED_CHIP_RENDER_LIMIT || el.scrollHeight > el.clientHeight + 1,
    )
  }, [tags, expanded, selectedPanelTags.length])

  const renderedTags = expanded ? tags : tags.slice(0, COLLAPSED_CHIP_RENDER_LIMIT)

  useEffect(() => {
    if (!expanded) return
    return registerEscapeHandler(() => setExpanded(false))
  }, [expanded])

  if (tags.length === 0 && selectedPanelTags.length === 0) {
    return <div className="tag-picker-empty">{emptyMessage}</div>
  }

  return (
    <div className="tag-filter-stack">
      {selectedPanelTags.length > 0 && (
        <div className="tag-picker-selected" aria-label="Selected tags">
          {selectedPanelTags.map((tag) => (
            <TagDisplayChip
              key={`sel-${tag.id}-${tag.name}`}
              tag={{ ...tag, is_manual: false }}
              active
              onClick={onTagClick ? () => onTagClick(tag.name) : undefined}
            />
          ))}
        </div>
      )}
      {tags.length > 0 && (
        <div className="tag-filter-wrap tag-picker-list-wrap">
          <div
            ref={panelRef}
            className={`tag-filter-panel${expanded ? '' : ' collapsed'}`}
            style={expanded ? undefined : { maxHeight: TWO_LINE_MAX_HEIGHT }}
          >
            {renderedTags.map((tag) => (
              <TagDisplayChip
                key={tag.name}
                tag={{ ...tag, is_manual: false }}
                active={activeNames.includes(tag.name)}
                onClick={onTagClick ? () => onTagClick(tag.name) : undefined}
              />
            ))}
          </div>
          {canCollapse && (
            <button
              type="button"
              className="btn tag-filter-toggle"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse tags' : 'Expand tags'}
            >
              {expanded ? '^' : 'v'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
