import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAppSettings } from '../api/client'
import type { Tag } from '../types'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import { registerEscapeHandler } from '../utils/escapeStack'
import { COLLAPSED_CHIP_RENDER_LIMIT, sortTags, TWO_LINE_MAX_HEIGHT } from '../utils/tagSort'
import TagChip, { type TagChipData } from './TagChip'

function tagToChip(tag: Tag): TagChipData {
  return {
    name: tag.name,
    color: tag.color,
    group: tag.group,
    is_manual: false,
  }
}

interface BaseProps {
  tags: Tag[]
  emptyMessage?: string
}

interface MultiProps extends BaseProps {
  mode: 'multi'
  selectedIds: number[]
  onChange: (ids: number[]) => void
}

interface SingleProps extends BaseProps {
  mode: 'single'
  selectedId: number | ''
  onChange: (id: number | '') => void
}

type Props = MultiProps | SingleProps

export default function CollapsibleTagChipSelectList(props: Props) {
  const { tags, emptyMessage = 'No tags match' } = props
  const [expanded, setExpanded] = useState(false)
  const [canCollapse, setCanCollapse] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const sortMode = appSettings?.tags_sort_mode ?? DEFAULT_APP_SETTINGS.tags_sort_mode

  const sorted = sortTags(tags, sortMode)

  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el || sorted.length === 0) {
      if (!expanded) setCanCollapse(false)
      return
    }
    if (expanded) {
      setCanCollapse(true)
      return
    }
    setCanCollapse(
      sorted.length > COLLAPSED_CHIP_RENDER_LIMIT || el.scrollHeight > el.clientHeight + 1,
    )
  }, [sorted, expanded])

  const renderedTags = expanded ? sorted : sorted.slice(0, COLLAPSED_CHIP_RENDER_LIMIT)

  useEffect(() => {
    if (!expanded) return
    return registerEscapeHandler(() => setExpanded(false))
  }, [expanded])

  const isActive = (id: number) =>
    props.mode === 'multi' ? props.selectedIds.includes(id) : props.selectedId === id

  const handleClick = (tag: Tag) => {
    if (props.mode === 'multi') {
      const next = props.selectedIds.includes(tag.id)
        ? props.selectedIds.filter((x) => x !== tag.id)
        : [...props.selectedIds, tag.id]
      props.onChange(next)
    } else {
      props.onChange(props.selectedId === tag.id ? '' : tag.id)
    }
  }

  if (sorted.length === 0) {
    return <div className="tag-picker-empty">{emptyMessage}</div>
  }

  return (
    <div className="tag-filter-wrap tag-picker-list-wrap">
      <div
        ref={panelRef}
        className={`tag-filter-panel tag-chip-select-inner${expanded ? '' : ' collapsed'}`}
        style={expanded ? undefined : { maxHeight: TWO_LINE_MAX_HEIGHT }}
      >
        {renderedTags.map((tag) => (
          <TagChip
            key={tag.id}
            tag={tagToChip(tag)}
            active={isActive(tag.id)}
            onClick={() => handleClick(tag)}
          />
        ))}
      </div>
      {canCollapse && (
        <button
          type="button"
          className="btn tag-filter-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse tags' : 'Expand tags'}
        >
          {expanded ? '^' : 'v'}
        </button>
      )}
    </div>
  )
}
