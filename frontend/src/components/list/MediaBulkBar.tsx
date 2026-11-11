import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { fetchTags } from '../../api/client'
import type { Tag } from '../../types'
import { SearchableTagMultiSelect } from '../TagChipSelect'

interface Props {
  selectedCount: number
  busy: boolean
  onDiscard?: () => void
  onDelete?: () => void
  onMark: (kind: 'identical' | 'similar') => void
  /** When set, shows Add tags for the current selection. */
  onAddTags?: (tagNames: string[]) => void | Promise<void>
  deletePending?: boolean
  markError?: string | null
  /** Library grids link the selection to itself and need two files. */
  markMin?: number
}

/** Selection actions under a media grid. Discard and delete render only when those handlers are set. */
export default function MediaBulkBar({
  selectedCount,
  busy,
  onDiscard,
  onDelete,
  onMark,
  onAddTags,
  deletePending = false,
  markError,
  markMin = 2,
}: Props) {
  const markDisabled = selectedCount < markMin || busy
  const markTitle =
    selectedCount < markMin ? `Select at least ${markMin === 1 ? 'one file' : 'two files'}` : undefined
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([])
  const { data: allTags = [] } = useQuery({
    queryKey: ['tags'],
    queryFn: fetchTags,
    enabled: Boolean(onAddTags) && tagPickerOpen,
  })
  const selectedNames = useMemo(
    () =>
      selectedTagIds
        .map((id) => allTags.find((t: Tag) => t.id === id)?.name)
        .filter((name): name is string => Boolean(name)),
    [allTags, selectedTagIds],
  )

  const applyTags = async () => {
    if (!onAddTags || selectedNames.length === 0 || selectedCount === 0) return
    await onAddTags(selectedNames)
    setSelectedTagIds([])
    setTagPickerOpen(false)
  }

  return (
    <div className="recent-scrape-bulk-bar-wrap">
      <div className="recent-scrape-bulk-bar">
        <span>{selectedCount} selected</span>
        {onDiscard && (
          <button
            type="button"
            className="btn btn-small"
            disabled={selectedCount === 0 || busy}
            onClick={onDiscard}
          >
            Discard
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={selectedCount === 0 || busy}
            onClick={onDelete}
          >
            {deletePending ? 'Working…' : 'Permanent delete'}
          </button>
        )}
        {onAddTags && (
          <button
            type="button"
            className={`btn btn-small${tagPickerOpen ? ' btn-primary' : ''}`}
            disabled={selectedCount === 0 || busy}
            onClick={() => setTagPickerOpen((open) => !open)}
            aria-expanded={tagPickerOpen}
          >
            Add tags
          </button>
        )}
        <span>Mark as</span>
        <button
          type="button"
          className="btn btn-small"
          disabled={markDisabled}
          title={markTitle}
          onClick={() => onMark('identical')}
        >
          Identical
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={markDisabled}
          title={markTitle}
          onClick={() => onMark('similar')}
        >
          Similar
        </button>
        {markError && <span className="error">{markError}</span>}
      </div>
      {onAddTags && tagPickerOpen && (
        <div className="media-bulk-tag-picker">
          <SearchableTagMultiSelect
            tags={allTags}
            selectedIds={selectedTagIds}
            searchPlaceholder="Search tags to add…"
            onChange={setSelectedTagIds}
          />
          <div className="media-bulk-tag-picker-actions">
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={selectedCount === 0 || selectedNames.length === 0 || busy}
              onClick={() => void applyTags()}
            >
              Add to selected ({selectedNames.length || 0})
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => {
                setTagPickerOpen(false)
                setSelectedTagIds([])
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
