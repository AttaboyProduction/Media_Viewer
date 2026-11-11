import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MediaItem } from '../types'
import { fetchTagGroups, fetchTags, fetchAppSettings, updateMediaTags } from '../api/client'
import CollapsibleTagChipList from './CollapsibleTagChipList'
import TagChip from './TagChip'
import TagDisplayChip from './TagDisplayChip'
import TagSearchFilters from './TagSearchFilters'
import { useTagSearch } from '../hooks/useTagSearch'
import { normalizeTagQuery, sortTags, tagToMediaTag } from '../utils/tagSort'
import { registerEscapeHandler } from '../utils/escapeStack'

const TAG_PREVIEW_COUNT = 25
/** Fictitious Show more / Show less chip. */
const TOGGLE_TAG_COLOR = '#4a4a4a'

interface Props {
  media: MediaItem
}

export default function TagEditor({ media }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const { search, setSearch, matches, filterProps, groupFilterIds } = useTagSearch()
  /** null = follow setting; once user toggles, keep that choice across media. */
  const [tagsExpanded, setTagsExpanded] = useState<boolean | null>(null)

  const queryClient = useQueryClient()
  const { data: allTags = [] } = useQuery({ queryKey: ['tags'], queryFn: fetchTags })
  const { data: groups = [] } = useQuery({ queryKey: ['tag-groups'], queryFn: fetchTagGroups })
  const { data: appSettings } = useQuery({ queryKey: ['app-settings'], queryFn: fetchAppSettings })
  const useAliasDisplay = appSettings?.display_tag_aliases ?? true
  const sortMode = appSettings?.tags_sort_mode ?? 'order'
  const collapseByDefault = appSettings?.media_detail_tags_collapsed ?? true
  const expanded = tagsExpanded ?? !collapseByDefault

  const mutation = useMutation({
    mutationFn: ({
      add,
      remove,
      groupIds,
    }: {
      add: string[]
      remove: string[]
      groupIds?: number[]
    }) => updateMediaTags(media.id, add, remove, groupIds ?? []),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['media', media.id] })
      queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
  })

  const mediaTagNames = useMemo(() => new Set(media.tags.map((t) => t.name)), [media.tags])

  const sortedMediaTags = useMemo(
    () => sortTags(media.tags, sortMode),
    [media.tags, sortMode],
  )
  const needsToggle = sortedMediaTags.length > TAG_PREVIEW_COUNT
  const visibleTags =
    expanded || !needsToggle ? sortedMediaTags : sortedMediaTags.slice(0, TAG_PREVIEW_COUNT)
  const hiddenCount = sortedMediaTags.length - TAG_PREVIEW_COUNT

  const pickerTags = useMemo(() => {
    const filtered = allTags.filter((tag) => !mediaTagNames.has(tag.name) && matches(tag))
    return sortTags(filtered, sortMode).map((tag) => tagToMediaTag(tag, { useAliasDisplay }))
  }, [allTags, mediaTagNames, matches, useAliasDisplay, sortMode])

  const normalizedSearch = normalizeTagQuery(search)
  const canCreateNew =
    normalizedSearch.length > 0 &&
    !mediaTagNames.has(normalizedSearch) &&
    !allTags.some((t) => t.name === normalizedSearch)

  const addTags = (names: string[], groupIds?: number[]) => {
    const unique = names.filter((n) => n && !mediaTagNames.has(n))
    if (unique.length === 0) return
    mutation.mutate({
      add: unique,
      remove: [],
      ...(groupIds && groupIds.length > 0 ? { groupIds } : {}),
    })
  }

  const addFromSearch = () => {
    const exact = allTags.find((t) => t.name === normalizedSearch)
    if (exact && !mediaTagNames.has(exact.name)) {
      addTags([exact.name])
      setSearch('')
      return
    }
    if (canCreateNew) {
      // Selected group filter chips become the new tag's parent group(s).
      addTags([normalizedSearch], [...groupFilterIds])
      setSearch('')
    }
  }

  const onPickTag = (name: string) => {
    addTags([name])
  }

  useEffect(() => {
    setPickerOpen(false)
  }, [media.id])

  useEffect(() => {
    if (!pickerOpen) return
    return registerEscapeHandler(() => setPickerOpen(false))
  }, [pickerOpen])

  return (
    <div className="tag-editor">
      <div className="tag-row tag-editor-current">
        {visibleTags.map((tag) => (
          <TagDisplayChip
            key={tag.id}
            tag={tag}
            onRemove={() => mutation.mutate({ add: [], remove: [tag.name] })}
          />
        ))}
        {needsToggle && !expanded && (
          <TagChip
            tag={{ name: `Show more (+${hiddenCount})`, color: TOGGLE_TAG_COLOR }}
            onClick={() => setTagsExpanded(true)}
            className="tag-chip-toggle-more"
          />
        )}
        {needsToggle && expanded && (
          <TagChip
            tag={{ name: 'Show less', color: TOGGLE_TAG_COLOR }}
            onClick={() => setTagsExpanded(false)}
            className="tag-chip-toggle-more"
          />
        )}
        <button
          type="button"
          className="btn btn-small tag-add-open-btn"
          onClick={() => setPickerOpen((v) => !v)}
          aria-expanded={pickerOpen}
          aria-label={pickerOpen ? 'Close tag picker' : 'Add tags'}
        >
          {pickerOpen ? '×' : '+'}
        </button>
      </div>

      {pickerOpen && (
        <div className="tag-add-panel">
          <TagSearchFilters
            groups={groups}
            {...filterProps}
            placeholder="Type to search or add a tag..."
            onSearchKeyDown={(e) => {
              if (e.key === 'Enter') addFromSearch()
            }}
          />

          <CollapsibleTagChipList
            tags={pickerTags}
            onTagClick={onPickTag}
            emptyMessage="No matching tags — press Enter to create one"
          />

          {canCreateNew && (
            <button type="button" className="btn btn-small" onClick={addFromSearch}>
              Add new tag &quot;{normalizedSearch}&quot;
            </button>
          )}
        </div>
      )}

      {mutation.isError && <div className="error">Failed to update tags</div>}
    </div>
  )
}
