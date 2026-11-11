import type { ReactNode } from 'react'

interface Props {
  label: string
  children: ReactNode
  className?: string
}

export default function FormField({ label, children, className = '' }: Props) {
  return (
    <div className={`form-field${className ? ` ${className}` : ''}`}>
      <label className="form-field-label">{label}</label>
      {children}
    </div>
  )
}
