import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import { fetchTagGroups, fetchTags } from '../api/client'
import {
  joinCommaSeparatedTags,
  parseCommaSeparatedTags,
  tagBelongsToGroupKeys,
} from '../utils/tagList'

import GroupChip from './GroupChip'
import { SearchableGroupMultiSelect } from './GroupChipSelect'
import TagChip from './TagChip'
import { SearchableTagMultiSelect } from './TagChipSelect'

interface Props {
  tagValue: string
  groupValue: string
  onChange: (tags: string, groups: string) => void
}

export default function HiddenTagsPicker({ tagValue, groupValue, onChange }: Props) {
  const { data: allTags = [] } = useQuery({ queryKey: ['tags'], queryFn: fetchTags })
  const { data: groups = [] } = useQuery({ queryKey: ['tag-groups'], queryFn: fetchTagGroups })

  const selectedTagNames = useMemo(() => parseCommaSeparatedTags(tagValue), [tagValue])
  const selectedGroupKeys = useMemo(() => parseCommaSeparatedTags(groupValue), [groupValue])
  const selectedGroups = useMemo(
    () =>
      selectedGroupKeys
        .map((key) => groups.find((g) => g.key === key))
        .filter((g): g is NonNullable<typeof g> => Boolean(g)),
    [groups, selectedGroupKeys],
  )
  const individualTagNames = useMemo(
    () =>
      selectedTagNames.filter((name) => {
        const tag = allTags.find((t) => t.name === name)
        return tag ? !tagBelongsToGroupKeys(tag, selectedGroupKeys) : true
      }),
    [selectedTagNames, selectedGroupKeys, allTags],
  )
  const pickableTags = useMemo(
    () => allTags.filter((t) => !tagBelongsToGroupKeys(t, selectedGroupKeys)),
    [allTags, selectedGroupKeys],
  )
  const selectedTagIds = useMemo(
    () => pickableTags.filter((t) => individualTagNames.includes(t.name)).map((t) => t.id),
    [pickableTags, individualTagNames],
  )

  const stripTagsInGroups = (tagNames: string[], groupKeys: string[]) =>
    tagNames.filter((name) => {
      const tag = allTags.find((t) => t.name === name)
      return tag ? !tagBelongsToGroupKeys(tag, groupKeys) : true
    })

  const commit = (tagNames: string[], groupKeys: string[]) => {
    onChange(
      joinCommaSeparatedTags(stripTagsInGroups(tagNames, groupKeys)),
      joinCommaSeparatedTags(groupKeys),
    )
  }

  useEffect(() => {
    if (allTags.length === 0) return
    const cleaned = joinCommaSeparatedTags(stripTagsInGroups(selectedTagNames, selectedGroupKeys))
    if (cleaned !== tagValue) {
      onChange(cleaned, groupValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChange intentionally omitted
  }, [allTags, tagValue, groupValue, selectedTagNames, selectedGroupKeys])

  const updateTagIds = (ids: number[]) => {
    const names = ids
      .map((id) => pickableTags.find((t) => t.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    commit(names, selectedGroupKeys)
  }

  const removeTagName = (name: string) => {
    commit(
      individualTagNames.filter((n) => n !== name),
      selectedGroupKeys,
    )
  }

  const toggleGroup = (key: string) => {
    const nextGroupKeys = selectedGroupKeys.includes(key)
      ? selectedGroupKeys.filter((k) => k !== key)
      : [...selectedGroupKeys, key]
    commit(selectedTagNames, nextGroupKeys)
  }

  const updateGroupIds = (ids: number[]) => {
    const nextGroupKeys = ids
      .map((id) => groups.find((g) => g.id === id)?.key)
      .filter((key): key is string => Boolean(key))
    commit(selectedTagNames, nextGroupKeys)
  }

  return (
    <div className="hidden-tags-picker">
      <div className="hidden-tags-current">
        <span className="hidden-tags-current-label">Currently hidden</span>
        <p className="settings-field-hint hidden-tags-current-hint">
          Media with these tags or groups is hidden when Hide hidden tags is on in the viewer. Click
          a chip to remove it.
        </p>
        {selectedGroups.length > 0 || individualTagNames.length > 0 ? (
          <div className="exclude-tags-selected hidden-tags-current-chips">
            {selectedGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                className="group-chip-select-btn active"
                onClick={() => toggleGroup(group.key)}
              >
                <GroupChip group={group} small />
              </button>
            ))}
            {individualTagNames.map((name) => {
              const tag = allTags.find((t) => t.name === name)
              return (
                <TagChip
                  key={name}
                  tag={{
                    name,
                    color: tag?.color ?? '#bdc3c7',
                    group: tag?.group ?? null,
                    is_manual: false,
                  }}
                  active
                  onClick={() => removeTagName(name)}
                />
              )
            })}
          </div>
        ) : (
          <p className="hidden-tags-current-empty">Nothing selected yet.</p>
        )}
      </div>

      <div className="hidden-tags-add">
        <p className="hidden-tags-add-heading">Select tags to hide</p>
        <p className="settings-field-hint hidden-tags-add-hint">
          Choose groups or individual tags below. They appear in Currently hidden when selected.
        </p>

        <div className="hidden-tags-section">
          <span className="hidden-tags-section-label">Tag groups to hide</span>
          <p className="settings-field-hint hidden-tags-section-hint">
            Hides every tag in the group, including tags added to that group later.
          </p>
          <SearchableGroupMultiSelect
            groups={groups}
            selectedIds={selectedGroups.map((g) => g.id)}
            onChange={updateGroupIds}
            showSelectedPanel={false}
            searchPlaceholder="Search groups to hide..."
            emptyLabel="No groups"
          />
        </div>

        <div className="hidden-tags-section">
          <span className="hidden-tags-section-label">Individual tags to hide</span>
          <SearchableTagMultiSelect
            tags={pickableTags}
            selectedIds={selectedTagIds}
            onChange={updateTagIds}
            showSelectedPanel={false}
            searchPlaceholder="Search tags to hide..."
            emptyLabel={
              pickableTags.length === 0 && selectedGroupKeys.length > 0
                ? 'All tags are covered by selected groups'
                : 'No matching tags'
            }
          />
        </div>
      </div>
    </div>
  )
}
