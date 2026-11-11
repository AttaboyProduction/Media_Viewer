import { SettingsNumberInput } from './SettingsNumberInput'
import {
  normalizePageSizeOptions,
  suggestNextPageSize,
} from '../utils/pageSizeOptions'

interface Props {
  values: number[]
  min: number
  max: number
  /** Step used when adding a new option (viewer 12, tags 25). */
  addStep: number
  fallback: readonly number[]
  onChange: (next: number[]) => void
}

export function SettingsPageSizeList({
  values,
  min,
  max,
  addStep,
  fallback,
  onChange,
}: Props) {
  const update = (next: number[]) => {
    onChange(normalizePageSizeOptions(next, min, max, fallback))
  }

  return (
    <div className="settings-page-size-list">
      {values.map((size, index) => (
        <div key={`${index}-${size}`} className="settings-page-size-row">
          <SettingsNumberInput
            value={size}
            min={min}
            max={max}
            onCommit={(n) => {
              const next = [...values]
              next[index] = n
              update(next)
            }}
          />
          <button
            type="button"
            className="btn btn-small"
            disabled={values.length <= 1}
            onClick={() => {
              if (values.length <= 1) return
              update(values.filter((_, i) => i !== index))
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-small"
        onClick={() => {
          const nextValue = suggestNextPageSize(values, min, max, addStep)
          update([...values, nextValue])
        }}
      >
        Add
      </button>
    </div>
  )
}
