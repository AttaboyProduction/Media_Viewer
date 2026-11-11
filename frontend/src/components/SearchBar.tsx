import type { KeyboardEventHandler } from 'react'
import type { SearchMatchMode } from '../utils/tagSort'

interface Props {
  value: string
  onChange: (value: string) => void
  mode: SearchMatchMode
  onModeChange: (mode: SearchMatchMode) => void
  placeholder?: string
  className?: string
  inputClassName?: string
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  /** Put Contains/Exact under a full-width input (viewer sidebar). */
  stacked?: boolean
}

export default function SearchBar({
  value,
  onChange,
  mode,
  onModeChange,
  placeholder = 'Search...',
  className = '',
  inputClassName = '',
  onKeyDown,
  stacked = false,
}: Props) {
  return (
    <div
      className={`search-bar${stacked ? ' search-bar-stacked' : ''}${className ? ` ${className}` : ''}`}
    >
      <input
        className={inputClassName}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={onKeyDown}
      />
      <div className="search-match-toggle" role="group" aria-label="Search match mode">
        <button
          type="button"
          className={`search-match-btn${mode === 'contains' ? ' active' : ''}`}
          onClick={() => onModeChange('contains')}
          title="Match any part of the name"
        >
          Contains
        </button>
        <button
          type="button"
          className={`search-match-btn${mode === 'exact' ? ' active' : ''}`}
          onClick={() => onModeChange('exact')}
          title="Match the whole name only"
        >
          Exact
        </button>
      </div>
    </div>
  )
}
