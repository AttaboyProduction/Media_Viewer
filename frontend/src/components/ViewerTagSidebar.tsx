import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAppSettings, fetchTags } from '../api/client'
import type { MediaItem, Tag, TagGroup } from '../types'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import { readableTagColor, themeSurfaceColors } from '../utils/colorContrast'
import { mediaForPageTagList } from '../utils/contentHide'
import { decodeHtmlEntities } from '../utils/htmlEntities'
import TagListSearch from './TagListSearch'

const PER_GROUP = 10

interface Row {
  name: string
  color: string
  count: number
  group: TagGroup | null
}

function pageRows(items: MediaItem[], catalog: Map<string, Tag>, selected: string[]): Row[] {
  const map = new Map<string, Row>()
  const add = (name: string, color: string, group: TagGroup | null) => {
    if (map.has(name)) return
    const known = catalog.get(name)
    map.set(name, {
      name,
      color: known?.color || color,
      count: known?.usage_count ?? 0,
      group: known?.group ?? group,
    })
  }
  for (const item of items) {
    for (const tag of item.tags) add(tag.name, tag.color, tag.group)
  }
  for (const name of selected) {
    const known = catalog.get(name)
    add(name, known?.color ?? '#bdc3c7', known?.group ?? null)
  }
  return [...map.values()]
}

export default function ViewerTagSidebar({
  items,
  selectedTags,
  onToggle,
  onClear,
  tagMode,
  onTagModeChange,
}: {
  items: MediaItem[]
  selectedTags: string[]
  onToggle: (name: string) => void
  onClear: () => void
  tagMode: 'and' | 'or'
  onTagModeChange: (mode: 'and' | 'or') => void
}) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const { data: tags = [] } = useQuery({ queryKey: ['tags'], queryFn: fetchTags, staleTime: 30_000 })
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 30_000,
  })
  const prefs = appSettings ?? DEFAULT_APP_SETTINGS
  const catalog = useMemo(() => new Map(tags.map((tag) => [tag.name, tag])), [tags])
  const rows = useMemo(() => {
    const visible = mediaForPageTagList(
      items,
      prefs.content_hide_rules,
      prefs.content_hide_revealed_rule_ids,
    )
    return pageRows(visible, catalog, selectedTags)
  }, [
    items,
    catalog,
    selectedTags,
    prefs.content_hide_rules,
    prefs.content_hide_revealed_rule_ids,
  ])
  const selected = useMemo(() => new Set(selectedTags), [selectedTags])
  const surface = themeSurfaceColors()

  return (
    <aside className="viewer-tag-sidebar">
      <TagListSearch
        compact
        items={rows}
        searchCatalog={tags.map((tag) => ({
          id: tag.id,
          name: tag.name,
          group: tag.group,
          color: tag.color,
          count: tag.usage_count,
          usage_count: tag.usage_count,
        }))}
        separateGroupSearch
        tagMode={tagMode}
        onTagModeChange={onTagModeChange}
        onClearSelected={selectedTags.length > 0 ? onClear : undefined}
        onSuggestPick={onToggle}
      >
        {(filtered, filtersActive) => {
          const groups = new Map<string, { label: string; order: number; rows: Row[] }>()
          for (const tag of filtered) {
            const extra = tag as Row & { usage_count?: number }
            const row: Row = {
              name: extra.name,
              color: extra.color || '#bdc3c7',
              count: extra.count ?? extra.usage_count ?? 0,
              group: extra.group,
            }
            const key = row.group ? String(row.group.id) : 'none'
            const bucket = groups.get(key) ?? {
              label: row.group?.label ?? 'Ungrouped',
              order: row.group?.sort_order ?? 9999,
              rows: [],
            }
            bucket.rows.push(row)
            groups.set(key, bucket)
          }
          const ordered = [...groups.entries()].sort((a, b) => a[1].order - b[1].order)
          if (ordered.length === 0) {
            return <p className="settings-hint">No tags on this page.</p>
          }
          return (
            <div className="viewer-tag-groups">
              {ordered.map(([key, group]) => {
                const ranked = [...group.rows].sort(
                  (a, b) => b.count - a.count || a.name.localeCompare(b.name),
                )
                const expanded = filtersActive || openGroups.has(key)
                const visible = expanded ? ranked : ranked.slice(0, PER_GROUP)
                return (
                  <section key={key}>
                    <h3 className="viewer-tag-group-title">{decodeHtmlEntities(group.label)}</h3>
                    <ul>
                      {visible.map((row) => (
                        <li key={row.name}>
                          <button
                            type="button"
                            className={`viewer-tag-row${selected.has(row.name) ? ' selected' : ''}`}
                            onClick={() => onToggle(row.name)}
                          >
                            <span
                              className="viewer-tag-name"
                              style={{
                                color: readableTagColor(row.color, surface.background, surface.ink),
                              }}
                            >
                              {decodeHtmlEntities(row.name)}
                            </span>
                            <span className="viewer-tag-count">({row.count})</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {!filtersActive && ranked.length > PER_GROUP && (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() =>
                          setOpenGroups((prev) => {
                            const next = new Set(prev)
                            if (next.has(key)) next.delete(key)
                            else next.add(key)
                            return next
                          })
                        }
                      >
                        {expanded ? 'Show less' : `Show more (+${ranked.length - PER_GROUP})`}
                      </button>
                    )}
                  </section>
                )
              })}
            </div>
          )
        }}
      </TagListSearch>
    </aside>
  )
}
