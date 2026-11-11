import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  createTagGroup,
  deleteTagGroup,
  fetchAppSettings,
  fetchTagGroups,
  patchAppSettings,
  patchTagGroup,
} from '../api/client'
import FormField from '../components/FormField'
import GroupChip from '../components/GroupChip'
import { useConfirm } from '../context/ConfirmContext'
import { useSaveFeedback, withSavedFeedback } from '../context/SaveFeedbackContext'
import type { TagGroup } from '../types'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../types/appSettings'
import { applySparseMoveSortOrder, dropPlacementFromPointer, reorderIdsWithPlacement, setRowDragImage, sortOrderForDrop, type DropPlacement } from '../utils/rowReorder'

export default function TagGroupsPage() {
  const queryClient = useQueryClient()
  const { notifySaved } = useSaveFeedback()
  const { confirm } = useConfirm()

  const { data: appSettings } = useQuery({ queryKey: ['app-settings'], queryFn: fetchAppSettings })
  const nextColor =
    appSettings?.tag_group_next_color ?? DEFAULT_APP_SETTINGS.tag_group_next_color
  const fallbackColor =
    appSettings?.tag_group_default_color ?? DEFAULT_APP_SETTINGS.tag_group_default_color
  const autoOrderMode =
    appSettings?.tags_auto_order_mode ?? DEFAULT_APP_SETTINGS.tags_auto_order_mode

  const [newGroupKey, setNewGroupKey] = useState('')
  const [newGroupLabel, setNewGroupLabel] = useState('')
  const [newGroupColor, setNewGroupColor] = useState(nextColor)
  const [newGroupOrder, setNewGroupOrder] = useState('')
  const [colorTouched, setColorTouched] = useState(false)
  const [dragGroupId, setDragGroupId] = useState<number | null>(null)
  const [previewIds, setPreviewIds] = useState<number[] | null>(null)
  const [dropGuide, setDropGuide] = useState<{ id: number; placement: DropPlacement } | null>(null)
  const dropTargetIdRef = useRef<number | null>(null)
  const dropPlacementRef = useRef<DropPlacement>('before')
  const dragFromIdRef = useRef<number | null>(null)
  const dropHandledRef = useRef(false)

  useEffect(() => {
    if (!colorTouched) setNewGroupColor(nextColor)
  }, [nextColor, colorTouched])

  const { data: groups = [] } = useQuery({ queryKey: ['tag-groups'], queryFn: fetchTagGroups })

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)),
    [groups],
  )

  const displayGroups = useMemo(() => {
    if (!previewIds) return sortedGroups
    const map = new Map(sortedGroups.map((group) => [group.id, group]))
    return previewIds.map((id) => map.get(id)).filter((group): group is TagGroup => Boolean(group))
  }, [sortedGroups, previewIds])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tags'] })
    queryClient.invalidateQueries({ queryKey: ['tag-groups'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['app-settings'] })
  }

  const saveAndInvalidate = async (action: () => Promise<unknown>) => {
    await withSavedFeedback(notifySaved, async () => {
      await action()
      invalidate()
    })
  }

  const saveGroupOrder = async (id: number, sortOrder: number) => {
    await withSavedFeedback(notifySaved, async () => {
      queryClient.setQueryData<TagGroup[]>(['tag-groups'], (prev) =>
        prev ? applySparseMoveSortOrder(prev, id, sortOrder) : prev,
      )
      await patchTagGroup(id, { sort_order: sortOrder })
      await queryClient.invalidateQueries({ queryKey: ['tag-groups'] })
    })
  }

  const clearDrag = () => {
    setDragGroupId(null)
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
    const dragged = groups.find((g) => g.id === fromId)
    const target = groups.find((g) => g.id === targetId)
    if (!dragged || !target) return
    const nextOrder = sortOrderForDrop(target.sort_order, placement)
    if (nextOrder === dragged.sort_order) return
    void saveGroupOrder(fromId, nextOrder)
  }

  const createGroupMutation = useMutation({
    mutationFn: () => {
      const orderText = newGroupOrder.trim()
      const sortOrder = orderText === '' ? undefined : Number(orderText)
      if (sortOrder !== undefined && !Number.isFinite(sortOrder)) {
        throw new Error('Order must be a number')
      }
      return createTagGroup({
        key: newGroupKey,
        label: newGroupLabel || newGroupKey,
        default_color: newGroupColor,
        ...(sortOrder !== undefined ? { sort_order: sortOrder } : {}),
      })
    },
    onSuccess: async () => {
      invalidate()
      notifySaved()
      setNewGroupKey('')
      setNewGroupLabel('')
      setNewGroupOrder('')
      setColorTouched(false)
      const settings = await queryClient.fetchQuery({
        queryKey: ['app-settings'],
        queryFn: fetchAppSettings,
      })
      setNewGroupColor(settings.tag_group_next_color || fallbackColor)
    },
  })

  const deleteGroupMutation = useMutation({
    mutationFn: deleteTagGroup,
    onSuccess: () => {
      invalidate()
      notifySaved()
    },
  })

  const saveAutoOrderMode = async (mode: AppSettings['tags_auto_order_mode']) => {
    await withSavedFeedback(notifySaved, async () => {
      const next = await patchAppSettings({ tags_auto_order_mode: mode })
      queryClient.setQueryData(['app-settings'], next)
    })
  }

  const submitGroup = () => {
    if (!newGroupKey.trim() || createGroupMutation.isPending) return
    createGroupMutation.mutate()
  }

  return (
    <div className="page">
      <div className="page-header">
        <Link to="/tags" className="btn btn-small">
          ← Back to tags
        </Link>
        <h2 className="page-title">Tag groups</h2>
        <div className="page-header-actions">
          <Link to="/tags/groups/settings" className="btn">
            Group settings
          </Link>
        </div>
      </div>

      <div className="panel">
        <h2>Add tag group</h2>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault()
            submitGroup()
          }}
        >
          <FormField label="Key">
            <input
              value={newGroupKey}
              onChange={(e) => setNewGroupKey(e.target.value)}
              placeholder="e.g. group_key"
            />
          </FormField>
          <FormField label="Label">
            <input
              value={newGroupLabel}
              onChange={(e) => setNewGroupLabel(e.target.value)}
              placeholder="e.g. display_name"
            />
          </FormField>
          <FormField label="Color">
            <input
              type="color"
              value={newGroupColor}
              onChange={(e) => {
                setColorTouched(true)
                setNewGroupColor(e.target.value)
              }}
            />
          </FormField>
          <FormField label="Order">
            <input
              type="number"
              value={newGroupOrder}
              onChange={(e) => setNewGroupOrder(e.target.value)}
              placeholder="Optional"
            />
          </FormField>
          <FormField label="Auto order (if empty)">
            <select
              value={autoOrderMode}
              onChange={(e) =>
                void saveAutoOrderMode(e.target.value as AppSettings['tags_auto_order_mode'])
              }
            >
              <option value="by_name">Insert by name</option>
              <option value="end">Add at end</option>
            </select>
          </FormField>
          <div className="form-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!newGroupKey.trim() || createGroupMutation.isPending}
            >
              Add group
            </button>
          </div>
        </form>
        {createGroupMutation.isError && (
          <div className="error">
            {createGroupMutation.error instanceof Error
              ? createGroupMutation.error.message
              : 'Failed to create group'}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>All tag groups</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="drag-col" aria-label="Reorder" />
                <th>Order</th>
                <th>Key</th>
                <th>Label</th>
                <th>Color</th>
                <th>Preview</th>
                <th>Default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {displayGroups.map((group) => (
                <tr
                  key={group.id}
                  className={[
                    dragGroupId === group.id ? 'row-dragging' : '',
                    dropGuide?.id === group.id ? `drop-guide-${dropGuide.placement}` : '',
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (dragGroupId == null || dragGroupId === group.id) return
                    e.dataTransfer.dropEffect = 'move'
                    const placement = dropPlacementFromPointer(
                      e.clientY,
                      e.currentTarget.getBoundingClientRect(),
                    )
                    dropTargetIdRef.current = group.id
                    dropPlacementRef.current = placement
                    setDropGuide({ id: group.id, placement })
                    setPreviewIds((prev) => {
                      const base = prev ?? sortedGroups.map((g) => g.id)
                      return reorderIdsWithPlacement(base, dragGroupId, group.id, placement)
                    })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    dropHandledRef.current = true
                    if (dragGroupId != null && group.id !== dragGroupId) {
                      dropTargetIdRef.current = group.id
                      dropPlacementRef.current = dropPlacementFromPointer(
                        e.clientY,
                        e.currentTarget.getBoundingClientRect(),
                      )
                    }
                    commitDragOrder()
                    setDragGroupId(null)
                    setPreviewIds(null)
                    setDropGuide(null)
                  }}
                >
                  <td className="drag-col">
                    <span
                      className="drag-handle"
                      draggable
                      title="Drag to reorder"
                      onDragStart={(e) => {
                        dropHandledRef.current = false
                        dragFromIdRef.current = group.id
                        dropTargetIdRef.current = null
                        dropPlacementRef.current = 'before'
                        setDragGroupId(group.id)
                        setPreviewIds(sortedGroups.map((g) => g.id))
                        setDropGuide(null)
                        e.dataTransfer.setData('text/group-id', String(group.id))
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
                      defaultValue={group.sort_order}
                      key={`g-order-${group.id}-${group.sort_order}`}
                      onBlur={(e) => {
                        const next = Number(e.target.value)
                        if (!Number.isFinite(next) || next === group.sort_order) return
                        void saveGroupOrder(group.id, next)
                      }}
                    />
                  </td>
                  <td>{group.key}</td>
                  <td>
                    <input
                      defaultValue={group.label}
                      onBlur={(e) =>
                        saveAndInvalidate(() => patchTagGroup(group.id, { label: e.target.value }))
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="color"
                      defaultValue={group.default_color}
                      onBlur={(e) =>
                        saveAndInvalidate(() =>
                          patchTagGroup(group.id, { default_color: e.target.value }),
                        )
                      }
                    />
                  </td>
                  <td>
                    <GroupChip group={group} />
                  </td>
                  <td>
                    <label className="default-group-switch">
                      <input
                        type="radio"
                        name="default-tag-group"
                        checked={group.is_default}
                        onChange={() =>
                          saveAndInvalidate(() => patchTagGroup(group.id, { is_default: true }))
                        }
                      />
                      {group.is_default ? 'Yes' : ''}
                    </label>
                  </td>
                  <td>
                    {group.key !== 'unknown' && (
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        disabled={deleteGroupMutation.isPending}
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Delete tag group',
                            message: `Delete group "${group.label}"? Tags stay, but this group is removed from them. Ungrouped tags move to Unknown.`,
                            confirmLabel: 'Delete',
                            danger: true,
                          })
                          if (ok) deleteGroupMutation.mutate(group.id)
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {deleteGroupMutation.isError && (
          <div className="error">
            {deleteGroupMutation.error instanceof Error
              ? deleteGroupMutation.error.message
              : 'Failed to delete group'}
          </div>
        )}
      </div>
    </div>
  )
}
