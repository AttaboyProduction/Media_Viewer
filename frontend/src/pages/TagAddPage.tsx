import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  createTag,
  deleteTag,
  fetchAppSettings,
  fetchTagGroups,
  patchAppSettings,
} from '../api/client'
import FormField from '../components/FormField'
import GroupChip from '../components/GroupChip'
import TagDisplayChip from '../components/TagDisplayChip'
import { useSaveFeedback, withSavedFeedback } from '../context/SaveFeedbackContext'
import type { Tag } from '../types'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../types/appSettings'

export default function TagAddPage() {
  const queryClient = useQueryClient()
  const { notifySaved } = useSaveFeedback()

  const [newTagName, setNewTagName] = useState('')
  const [newTagGroupId, setNewTagGroupId] = useState<number | ''>('')
  const [newTagOrder, setNewTagOrder] = useState('')
  const [sessionTags, setSessionTags] = useState<Tag[]>([])

  const { data: groups = [] } = useQuery({ queryKey: ['tag-groups'], queryFn: fetchTagGroups })
  const { data: appSettings } = useQuery({ queryKey: ['app-settings'], queryFn: fetchAppSettings })
  const defaultTagGroup = groups.find((g) => g.is_default)
  const autoOrderMode =
    appSettings?.tags_auto_order_mode ?? DEFAULT_APP_SETTINGS.tags_auto_order_mode

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tags'] })
    queryClient.invalidateQueries({ queryKey: ['tag-groups'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
  }

  const saveAutoOrderMode = async (mode: AppSettings['tags_auto_order_mode']) => {
    await withSavedFeedback(notifySaved, async () => {
      const next = await patchAppSettings({ tags_auto_order_mode: mode })
      queryClient.setQueryData(['app-settings'], next)
    })
  }

  const createTagMutation = useMutation({
    mutationFn: () => {
      const orderText = newTagOrder.trim()
      const sortOrder = orderText === '' ? undefined : Number(orderText)
      if (sortOrder !== undefined && !Number.isFinite(sortOrder)) {
        throw new Error('Order must be a number')
      }
      return createTag(
        newTagName,
        newTagGroupId ? [Number(newTagGroupId)] : [],
        sortOrder,
      )
    },
    onSuccess: (tag) => {
      invalidate()
      notifySaved()
      setSessionTags((prev) => [...prev, tag])
      setNewTagName('')
      setNewTagGroupId('')
      setNewTagOrder('')
    },
  })

  const deleteSessionTagMutation = useMutation({
    mutationFn: deleteTag,
    onSuccess: (_, tagId) => {
      invalidate()
      notifySaved()
      setSessionTags((prev) => prev.filter((t) => t.id !== tagId))
    },
  })

  const submitTag = () => {
    if (!newTagName.trim() || createTagMutation.isPending) return
    createTagMutation.mutate()
  }

  return (
    <div className="page">
      <div className="page-header">
        <Link to="/tags" className="btn btn-small">
          ← Back to tags
        </Link>
        <h2 className="page-title">Add tags</h2>
      </div>

      <div className="panel">
        <h2>Add tag</h2>
        <form
          className="add-tag-form"
          onSubmit={(e) => {
            e.preventDefault()
            submitTag()
          }}
        >
          <div className="add-tag-name-order-row">
            <FormField label="Tag name" className="add-tag-name-field">
              <input
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="e.g. tag_name"
              />
            </FormField>
            <FormField label="Order" className="add-tag-order-field">
              <input
                type="number"
                value={newTagOrder}
                onChange={(e) => setNewTagOrder(e.target.value)}
                placeholder="Optional"
              />
            </FormField>
          </div>
          <FormField label="Auto order (if Order empty)">
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
          <FormField label="Primary group" className="add-tag-groups-field">
            <div className="group-chip-select-grid group-chip-select-stretch">
              <button
                type="button"
                className={`group-chip-select-btn add-tag-default-btn${newTagGroupId === '' ? ' active' : ''}`}
                onClick={() => setNewTagGroupId('')}
                title={
                  defaultTagGroup
                    ? `Use default group: ${defaultTagGroup.label}`
                    : 'Use default tag group'
                }
              >
                {defaultTagGroup ? (
                  <>
                    <span className="add-tag-default-label">Default</span>
                    <GroupChip group={defaultTagGroup} small />
                  </>
                ) : (
                  'Default'
                )}
              </button>
              {groups
                .filter((group) => group.key !== 'unknown')
                .map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={`group-chip-select-btn${newTagGroupId === group.id ? ' active' : ''}`}
                    onClick={() => setNewTagGroupId(group.id)}
                  >
                    <GroupChip group={group} small />
                  </button>
                ))}
            </div>
          </FormField>
          <div className="form-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!newTagName.trim() || createTagMutation.isPending}
            >
              Add tag
            </button>
          </div>
        </form>
        {createTagMutation.isError && (
          <div className="error">
            {createTagMutation.error instanceof Error
              ? createTagMutation.error.message
              : 'Failed to create tag'}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Added this session</h2>
        {sessionTags.length === 0 ? (
          <p className="tag-picker-empty">Tags you add here will appear in this list.</p>
        ) : (
          <div className="tag-row">
            {sessionTags.map((tag) => (
              <TagDisplayChip
                key={tag.id}
                tag={tag}
                onRemove={() => {
                  if (!deleteSessionTagMutation.isPending) {
                    deleteSessionTagMutation.mutate(tag.id)
                  }
                }}
              />
            ))}
          </div>
        )}
        {deleteSessionTagMutation.isError && (
          <div className="error">
            {deleteSessionTagMutation.error instanceof Error
              ? deleteSessionTagMutation.error.message
              : 'Failed to delete tag'}
          </div>
        )}
      </div>
    </div>
  )
}
