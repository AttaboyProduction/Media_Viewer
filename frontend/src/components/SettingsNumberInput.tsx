import { useEffect, useState } from 'react'

interface Props {
  value: number
  min?: number
  max?: number
  onCommit: (value: number) => void
}

export function SettingsNumberInput({ value, min, max, onCommit }: Props) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    let next = parsed
    if (min != null) next = Math.max(min, next)
    if (max != null) next = Math.min(max, next)
    onCommit(next)
    setDraft(String(next))
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
    />
  )
}
