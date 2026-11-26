import type { RefObject } from 'react'
import FloatingPopover from './FloatingPopover'
import TagSearchSuggest from './TagSearchSuggest'

interface SuggestItem {
  id: string | number
  name: string
  color?: string
  usage_count?: number
}

/** Fixed layer + portal so scrape tag suggestions sit above panels and overflow clipping. */
export default function TagSearchSuggestFloating({
  anchorRef,
  query,
  items,
  onPick,
  onClickOutside,
  selectedNames,
}: {
  anchorRef: RefObject<HTMLElement | null>
  query: string
  items: SuggestItem[]
  onPick?: (name: string) => void
  onClickOutside?: () => void
  selectedNames?: ReadonlySet<string>
}) {
  const hasResults = query.trim().length > 0 && items.length > 0
  if (!hasResults) return null

  return (
    <FloatingPopover
      open
      anchorRef={anchorRef}
      matchAnchorWidth
      className="tag-filter-search-suggest-floating"
      onClickOutside={onClickOutside}
    >
      <TagSearchSuggest
        query={query}
        items={items}
        onPick={onPick}
        selectedNames={selectedNames}
      />
    </FloatingPopover>
  )
}