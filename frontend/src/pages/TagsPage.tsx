import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  deleteTag,
  fetchAppSettings,
  fetchTagGroups,
  fetchTags,
  patchTag,
  renameTag,
} from '../api/client'
import { usePageClamp } from '../hooks/usePageClamp'
import { usePersistedPageSize } from '../hooks/usePersistedPageSize'
import { useTagSearch } from '../hooks/useTagSearch'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import FormField from '../components/FormField'
import TagChip, { type TagChipData } from '../components/TagChip'
import TagGroupAssignments from '../components/TagGroupAssignments'
import TagSearchFilters from '../components/TagSearchFilters'
import { useSaveFeedback, withSavedFeedback } from '../context/SaveFeedbackContext'
import { useConfirm } from '../context/ConfirmContext'
import PaginationBar from '../components/list/PaginationBar'
import type { Tag } from '../types'
import { paginationTotalPages } from '../utils/pagination'
import { applyDenseMoveSortOrder, dropPlacementFromPointer, reorderIdsWithPlacement, setRowDragImage, sortOrderForDrop, type DropPlacement } from '../utils/rowReorder'
import { sortTags } from '../utils/tagSort'

function sameTagGroup(a: Tag, b: Tag) {
  return (a.group?.id ?? null) === (b.group?.id ?? null)
}

function AliasChips({ tag }: { tag: Tag }) {
  if (!tag.aliases?.length) return <>—</>
  return (
    <span className="tag-alias-list">
      {tag.aliases.map((name) => (
        <TagChip
          key={name}
          tag={{ name, color: tag.color, group: tag.group, is_manual: false }}
        />
      ))}
    </span>
  )
}

export default function TagsPage() {
  const queryClient = useQueryClient()
  const { notifySaved } = useSaveFeedback()
  const { confirm } = useConfirm()

  const { search, matchMode, groupFilterIds, matches, filterProps } = useTagSearch()
  const [page, setPage] = useState(1)
  const [dragTagId, setDragTagId] = useState<number | null>(null)
  const [previewIds, setPreviewIds] = useState<number[] | null>(null)
  const [dropGuide, setDropGuide] = useState<{ id: number; placement: DropPlacement } | null>(null)
  const dropTargetIdRef = useRef<number | null>(null)
  const dropPlacementRef = useRef<DropPlacement>('before')
  const dragFromIdRef = useRef<number | null>(null)
  const dropHandledRef = useRef(false)

  const { data: tags = [] } = useQuery({ queryKey: ['tags'], queryFn: fetchTags })
  const { data: groups = [] } = useQuery({ queryKey: ['tag-groups'], queryFn: fetchTagGroups })
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })

  const tagsPageSizeOptions =
    appSettings?.tags_page_sizes?.length
      ? appSettings.tags_page_sizes
      : DEFAULT_APP_SETTINGS.tags_page_sizes
  const tagsPageSizeAllowed = [...tagsPageSizeOptions, 0]
  const {
    pageSize,
    ready: pageSizeReady,
    pending: pageSizePending,
    changePageSize,
  } = usePersistedPageSize({
    settings: appSettings,
    settingKey: 'tags_page_size',
    fallback: DEFAULT_APP_SETTINGS.tags_page_size,
    onResetPage: () => setPage(1),
    allowedSizes: tagsPageSizeAllowed,
  })

  const sortMode = appSettings?.tags_sort_mode ?? DEFAULT_APP_SETTINGS.tags_sort_mode

  const filtered = useMemo(() => sortTags(tags.filter(matches), sortMode), [tags, matches, sortMode])

  const effectivePageSize =
    pageSize === 0 ? Math.max(filtered.length, 1) : (pageSize ?? DEFAULT_APP_SETTINGS.tags_page_size)
  const totalPages = paginationTotalPages(filtered.length, effectivePageSize)

  const pageItems = useMemo(() => {
    const start = (page - 1) * effectivePageSize
    return filtered.slice(start, start + effectivePageSize)
  }, [filtered, page, effectivePageSize])

  const displayItems = useMemo(() => {
    if (!previewIds) return pageItems
    const map = new Map(pageItems.map((tag) => [tag.id, tag]))
    return previewIds.map((id) => map.get(id)).filter((tag): tag is Tag => Boolean(tag))
  }, [pageItems, previewIds])

  useEffect(() => {
    setPage(1)
  }, [search, matchMode, groupFilterIds])

  usePageClamp(page, totalPages, setPage)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tags'] })
    queryClient.invalidateQueries({ queryKey: ['tag-groups'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
  }

  const saveAndInvalidate = async (action: () => Promise<unknown>) => {
    await withSavedFeedback(notifySaved, async () => {
      await action()
      invalidate()
    })
  }

  const saveTagOrder = async (id: number, sortOrder: number) => {
    await withSavedFeedback(notifySaved, async () => {
      queryClient.setQueryData<Tag[]>(['tags'], (prev) =>
        prev ? applyDenseMoveSortOrder(prev, id, sortOrder, sameTagGroup) : prev,
      )
      await patchTag(id, { sort_order: sortOrder })
      await queryClient.invalidateQueries({ queryKey: ['tags'] })
    })
  }

  const clearDrag = () => {
    setDragTagId(null)
    setPreviewIds(null)
    setDropGuide(null)
    dropTargetIdRef.current = null
    dropPlacementRef.current = 'before'
    dragFromIdRef.current = null
  }

  const commitDragOrder = () => {
    const fromId = dragFromIdRef.current
    const targetId = dropTargetIdRef.current
    const placement = dropPlacementRef.current
    if (fromId == null || targetId == null || fromId === targetId) return
    const dragged = tags.find((t) => t.id === fromId)
    const target = tags.find((t) => t.id === targetId)
    if (!dragged || !target) return
    if (!sameTagGroup(dragged, target)) return
    const nextOrder = sortOrderForDrop(target.sort_order, placement)
    if (nextOrder === dragged.sort_order) return
    void saveTagOrder(fromId, nextOrder)
  }

  const deleteMutation = useMutation({
    mutationFn: deleteTag,
    onSuccess: () => {
      invalidate()
      notifySaved()
    },
  })

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-title">Tags</h2>
        <div className="page-header-actions">
          <Link to="/tags/add" className="btn btn-primary">
            Add tags
          </Link>
          <Link to="/tags/groups" className="btn">
            Tag groups
          </Link>
          <Link to="/tags/settings" className="btn">
            Tag settings
          </Link>
        </div>
      </div>

      <div className="panel">
        <FormField label="Search">
          <TagSearchFilters groups={groups} placeholder="Search tags..." {...filterProps} />
        </FormField>

        <div className="table-wrap table-wrap-tag-groups">
          <table>
            <thead>
              <tr>
                <th className="drag-col" aria-label="Reorder" />
                <th>Order</th>
                <th>Name</th>
                <th>Preview</th>
                <th>Groups</th>
                <th>Usage</th>
                <th>Aliases</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {displayItems.map((tag) => (
                <tr
                  key={tag.id}
                  className={[
                    dragTagId === tag.id ? 'row-dragging' : '',
                    dropGuide?.id === tag.id ? `drop-guide-${dropGuide.placement}` : '',
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (dragTagId == null || dragTagId === tag.id) return
                    const dragged = tags.find((t) => t.id === dragTagId)
                    if (!dragged || !sameTagGroup(dragged, tag)) {
                      e.dataTransfer.dropEffect = 'none'
                      return
                    }
                    e.dataTransfer.dropEffect = 'move'
                    const placement = dropPlacementFromPointer(
                      e.clientY,
                      e.currentTarget.getBoundingClientRect(),
                    )
                    dropTargetIdRef.current = tag.id
                    dropPlacementRef.current = placement
                    setDropGuide({ id: tag.id, placement })
                    setPreviewIds((prev) => {
                      const base = prev ?? pageItems.map((t) => t.id)
                      return reorderIdsWithPlacement(base, dragTagId, tag.id, placement)
                    })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    dropHandledRef.current = true
                    if (dragTagId != null && tag.id !== dragTagId) {
                      dropTargetIdRef.current = tag.id
                      dropPlacementRef.current = dropPlacementFromPointer(
                        e.clientY,
                        e.currentTarget.getBoundingClientRect(),
                      )
                    }
                    commitDragOrder()
                    setDragTagId(null)
                    setPreviewIds(null)
                    setDropGuide(null)
                  }}
                >
                  <td className="drag-col">
                    <span
                      className="drag-handle"
                      draggable
                      title="Drag to reorder within group"
                      onDragStart={(e) => {
                        dropHandledRef.current = false
                        dragFromIdRef.current = tag.id
                        dropTargetIdRef.current = null
                        dropPlacementRef.current = 'before'
                        setDragTagId(tag.id)
                        setPreviewIds(pageItems.map((t) => t.id))
                        setDropGuide(null)
                        e.dataTransfer.setData('text/tag-id', String(tag.id))
                        e.dataTransfer.effectAllowed = 'move'
                        setRowDragImage(e, e.currentTarget.closest('tr'))
                      }}
                      onDragEnd={() => {
                        if (!dropHandledRef.current) commitDragOrder()
                        clearDrag()
                        dropHandledRef.current = false
                      }}
                    >
                      ⋮⋮
                    </span>
                  </td>
                  <td>
                    <input
                      type="number"
                      className="order-input"
                      defaultValue={tag.sort_order}
                      key={`order-${tag.id}-${tag.sort_order}`}
                      onBlur={(e) => {
                        const next = Number(e.target.value)
                        if (!Number.isFinite(next) || next === tag.sort_order) return
                        void saveTagOrder(tag.id, next)
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="inline-name-input"
                      defaultValue={tag.name}
                      onBlur={(e) => {
                        const next = e.target.value.trim()
                        if (!next || next === tag.name) return
                        saveAndInvalidate(() => renameTag(tag.id, next))
                      }}
                    />
                  </td>
                  <td>
                    <TagChip
                      tag={{
                        name: tag.name,
                        color: tag.color,
                        group: tag.group,
                        is_manual: false,
                      } satisfies TagChipData}
                    />
                  </td>
                  <td className="tag-groups-cell">
                    <TagGroupAssignments
                      tag={tag}
                      allGroups={groups}
                      onAddGroup={(groupId) =>
                        saveAndInvalidate(() => patchTag(tag.id, { add_group_ids: [groupId] }))
                      }
                      onRemoveGroup={(groupId) =>
                        saveAndInvalidate(() => patchTag(tag.id, { remove_group_ids: [groupId] }))
                      }
                      onReplaceGroup={(fromId, toId) =>
                        saveAndInvalidate(() =>
                          patchTag(tag.id, { replace_group: { from_id: fromId, to_id: toId } }),
                        )
                      }
                    />
                  </td>
                  <td>{tag.usage_count}</td>
                  <td>
                    <AliasChips tag={tag} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      disabled={deleteMutation.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Delete tag',
                          message: `Delete tag "${tag.name}"?`,
                          confirmLabel: 'Delete',
                          danger: true,
                        })
                        if (ok) deleteMutation.mutate(tag.id)
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && <div className="empty">No tags match your filters.</div>}

        {filtered.length > 0 && (
          <PaginationBar
            page={page}
            totalPages={totalPages}
            shown={pageItems.length}
            total={filtered.length}
            noun="tags"
            className="tags-pagination"
            onPageChange={setPage}
            pageSize={pageSize ?? DEFAULT_APP_SETTINGS.tags_page_size}
            pageSizeOptions={[
              ...tagsPageSizeOptions,
              { value: 0, label: 'All' },
            ]}
            pageSizeLabel="Per page"
            onPageSizeChange={changePageSize}
            pageSizeDisabled={!pageSizeReady || pageSizePending}
          />
        )}
      </div>
    </div>
  )
}
