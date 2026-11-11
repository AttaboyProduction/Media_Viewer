import type { ReactNode } from 'react'

interface OptionProps {
  label: string
  children: ReactNode
  hint?: string
}

export function SettingsOption({ label, children, hint }: OptionProps) {
  return (
    <div className="settings-option">
      <span className="settings-option-label">{label}</span>
      <div className="settings-option-control">{children}</div>
      {hint && <p className="settings-field-hint settings-option-hint">{hint}</p>}
    </div>
  )
}
