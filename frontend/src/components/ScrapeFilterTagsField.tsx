import { useMemo } from 'react'
import type { Tag } from '../types'
import TagChip from './TagChip'
import { SearchableTagMultiSelect } from './TagChipSelect'

interface Props {
  rowType: 'tag_or' | 'tag_and'
  onRowTypeChange: (type: 'tag_or' | 'tag_and') => void
  tags: Tag[]
  selectedNames: string[]
  onChange: (names: string[]) => void
  onRemove: () => void
  removeDisabled?: boolean
}

/** One-line scrape tag filter: Tags — or/and · search · Search groups · Remove. */
export default function ScrapeFilterTagsField({
  rowType,
  onRowTypeChange,
  tags,
  selectedNames,
  onChange,
  onRemove,
  removeDisabled,
}: Props) {
  const selectedIds = useMemo(() => {
    const ids: number[] = []
    for (const name of selectedNames) {
      const tag = tags.find((item) => item.name === name)
      if (tag) ids.push(tag.id)
    }
    return ids
  }, [selectedNames, tags])

  const handleIdsChange = (ids: number[]) => {
    const names = ids
      .map((id) => tags.find((tag) => tag.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    onChange(names)
  }

  return (
    <div className="scrape-filter-tags-row">
      <select
        className="scrape-filter-tags-type"
        value={rowType}
        onChange={(event) =>
          onRowTypeChange(event.target.value === 'tag_and' ? 'tag_and' : 'tag_or')
        }
        aria-label="How selected tags in this row combine"
      >
        <option value="tag_or">Tags — or</option>
        <option value="tag_and">Tags — and</option>
      </select>
      <div className="scrape-filter-tags-picker-wrap">
        <SearchableTagMultiSelect
          tags={tags}
          searchCatalog={tags}
          separateGroupSearch
          pinnedSearch
          suggestOverlay
          panelClassName="scrape-filter-tag-picker"
          selectedIds={selectedIds}
          onChange={handleIdsChange}
          searchPlaceholder="Search library tags..."
          showSelectedPanel={false}
          showChipList={false}
          toolbarActions={
            <button type="button" className="btn" onClick={onRemove} disabled={removeDisabled}>
              Remove
            </button>
          }
        />
      </div>
      {selectedNames.length > 0 && (
        <div className="scrape-filter-tags-selected" aria-label="Selected tags">
          {selectedNames.map((name) => {
            const tag = tags.find((item) => item.name === name)
            return (
              <TagChip
                key={name}
                tag={
                  tag
                    ? { name: tag.name, color: tag.color, group: tag.group, is_manual: false }
                    : { name, color: '', group: null, is_manual: false }
                }
                active
                onClick={() => onChange(selectedNames.filter((item) => item !== name))}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}