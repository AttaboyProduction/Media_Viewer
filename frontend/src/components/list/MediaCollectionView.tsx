import { Fragment, useRef, type CSSProperties, type ReactNode, type Ref } from 'react'
import { useHorizontalWheelNav } from '../../hooks/useHorizontalWheelNav'
import type { MediaItem } from '../../types'
import TagFilterPanel from '../TagFilterPanel'
import PaginationBar, { type PageSizeOption } from './PaginationBar'

interface TagFilterConfig {
  selectedTags: string[]
  onToggle: (name: string) => void
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  toolbarActions?: ReactNode
  onClearSelected?: () => void
  tagMode: 'and' | 'or'
  onTagModeChange: (mode: 'and' | 'or') => void
  chipsOnlyWhileSearching?: boolean
}

interface PaginationConfig {
  page: number
  totalPages: number
  total: number
  pageSize?: number
  pageSizeOptions?: readonly (number | PageSizeOption)[]
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  pageSizeDisabled?: boolean
}

interface Props {
  items: MediaItem[]
  renderItem: (item: MediaItem) => ReactNode
  gridClassName: string
  gridStyle?: CSSProperties
  gridRef?: Ref<HTMLDivElement>
  tagFilter?: TagFilterConfig
  beforeGrid?: ReactNode
  /** Shown under the tag filter, in the grid's place, when there are no items. */
  empty?: ReactNode
  pagination: PaginationConfig
  /** Fill parent height: scroll the grid, keep pagination docked at the bottom. */
  fillHeight?: boolean
}

export default function MediaCollectionView({
  items,
  renderItem,
  gridClassName,
  gridStyle,
  gridRef,
  tagFilter,
  beforeGrid,
  empty,
  pagination,
  fillHeight = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  useHorizontalWheelNav(rootRef, (direction) => {
    const pages = Math.max(1, pagination.totalPages)
    if (direction === 'prev' && pagination.page > 1) pagination.onPageChange(pagination.page - 1)
    if (direction === 'next' && pagination.page < pages) pagination.onPageChange(pagination.page + 1)
  })
  const showTagFilter =
    tagFilter &&
    (items.length > 0 ||
      tagFilter.selectedTags.length > 0 ||
      Boolean(tagFilter.toolbarActions))

  const paginationBar =
    items.length > 0 ? (
      <PaginationBar
        page={pagination.page}
        totalPages={pagination.totalPages}
        shown={items.length}
        total={pagination.total}
        onPageChange={pagination.onPageChange}
        pageSize={pagination.pageSize}
        pageSizeOptions={pagination.pageSizeOptions}
        onPageSizeChange={pagination.onPageSizeChange}
        pageSizeDisabled={pagination.pageSizeDisabled}
      />
    ) : null

  const body = (
    <>
      {showTagFilter && (
        <TagFilterPanel
          items={items}
          selectedTags={tagFilter.selectedTags}
          onToggle={tagFilter.onToggle}
          expanded={tagFilter.expanded}
          onExpandedChange={tagFilter.onExpandedChange}
          toolbarActions={tagFilter.toolbarActions}
          onClearSelected={tagFilter.onClearSelected}
          tagMode={tagFilter.tagMode}
          onTagModeChange={tagFilter.onTagModeChange}
          chipsOnlyWhileSearching={tagFilter.chipsOnlyWhileSearching}
        />
      )}
      {beforeGrid}
      {items.length === 0 && empty}
      {items.length > 0 && (
        <div ref={gridRef} className={gridClassName} style={gridStyle}>
          {items.map((item) => (
            <Fragment key={item.id}>{renderItem(item)}</Fragment>
          ))}
        </div>
      )}
    </>
  )

  if (!fillHeight) {
    return (
      <div ref={rootRef}>
        {body}
        {paginationBar}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="media-collection-fill">
      <div className="media-collection-scroll">{body}</div>
      {paginationBar}
    </div>
  )
}
