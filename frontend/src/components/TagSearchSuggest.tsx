import type { ReactNode } from 'react'
import { decodeHtmlEntities } from '../utils/htmlEntities'

interface SuggestItem {
  id: string | number
  name: string
  color?: string
  usage_count?: number
}

function highlight(name: string, query: string): ReactNode {
  const display = decodeHtmlEntities(name)
  const needle = query.trim().toLowerCase().replace(/\s+/g, '_')
  if (!needle) return display
  const index = display.toLowerCase().indexOf(needle)
  if (index < 0) return display
  return (
    <>
      {display.slice(0, index)}
      <mark className="tag-suggest-mark">{display.slice(index, index + needle.length)}</mark>
      {display.slice(index + needle.length)}
    </>
  )
}

export default function TagSearchSuggest({
  items,
  query,
  onPick,
}: {
  items: SuggestItem[]
  query: string
  onPick?: (name: string) => void
}) {
  const shown = items.slice(0, 8)
  if (!query.trim() || shown.length === 0) return null
  return (
    <ul className="tag-suggest" role="listbox">
      {shown.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="tag-suggest-row"
            style={item.color ? { color: item.color } : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick?.(item.name)}
          >
            <span>{highlight(item.name, query)}</span>
            {item.usage_count != null && (
              <span className="tag-suggest-count">({item.usage_count})</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
