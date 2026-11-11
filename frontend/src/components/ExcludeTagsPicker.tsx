import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { fetchAppSettings, fetchTags } from '../api/client'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import {
  expandHiddenTags,
  joinCommaSeparatedTags,
  parseCommaSeparatedTags,
} from '../utils/tagList'

import { SearchableTagMultiSelect } from './TagChipSelect'

interface Props {
  value: string
  onChange: (next: string) => void
}

export default function ExcludeTagsPicker({ value, onChange }: Props) {
  const { data: allTags = [] } = useQuery({ queryKey: ['tags'], queryFn: fetchTags })
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })

  const selectedNames = useMemo(() => parseCommaSeparatedTags(value), [value])
  const selectedIds = useMemo(
    () => allTags.filter((t) => selectedNames.includes(t.name)).map((t) => t.id),
    [allTags, selectedNames],
  )

  const hiddenTagNames = useMemo(() => {
    const tags = parseCommaSeparatedTags(
      appSettings?.viewer_exclude_tags ?? DEFAULT_APP_SETTINGS.viewer_exclude_tags,
    )
    const groups = parseCommaSeparatedTags(
      appSettings?.viewer_exclude_tag_groups ?? DEFAULT_APP_SETTINGS.viewer_exclude_tag_groups,
    )
    return expandHiddenTags(tags, groups, allTags)
  }, [appSettings, allTags])

  const hiddenNotYetSelected = useMemo(
    () => hiddenTagNames.filter((name) => !selectedNames.includes(name)),
    [hiddenTagNames, selectedNames],
  )

  const updateIds = (ids: number[]) => {
    const names = ids
      .map((id) => allTags.find((t) => t.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    onChange(joinCommaSeparatedTags(names))
  }

  const addHiddenTags = () => {
    if (hiddenNotYetSelected.length === 0) return
    onChange(joinCommaSeparatedTags([...selectedNames, ...hiddenNotYetSelected]))
  }

  return (
    <div className="exclude-tags-picker">
      <SearchableTagMultiSelect
        tags={allTags}
        selectedIds={selectedIds}
        onChange={updateIds}
        searchPlaceholder="Search tags to exclude..."
        emptyLabel="No matching tags"
        toolbarActions={
          <button
            type="button"
            className="btn btn-small"
            disabled={hiddenNotYetSelected.length === 0}
            onClick={addHiddenTags}
            title={
              hiddenNotYetSelected.length === 0
                ? hiddenTagNames.length === 0
                  ? 'No hidden tags configured in Settings'
                  : 'All hidden tags already selected'
                : `Add ${hiddenNotYetSelected.length} hidden tag(s) to exclude`
            }
          >
            Add hidden tags
          </button>
        }
      />
    </div>
  )
}
