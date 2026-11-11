import { useEffect, useRef, useState } from 'react'

import { useConfirm } from '../context/ConfirmContext'
import { registerEscapeHandler } from '../utils/escapeStack'
import { normalizePageSizeOptions } from '../utils/pageSizeOptions'
import { SettingsPageSizeList } from './SettingsPageSizeList'

interface Props {
  label: string
  hint?: string
  values: number[]
  min: number
  max: number
  addStep: number
  fallback: readonly number[]
  onSave: (next: number[]) => void | Promise<void>
}

function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i])
}

export function SettingsPageSizeListEditor({
  label,
  hint,
  values,
  min,
  max,
  addStep,
  fallback,
  onSave,
}: Props) {
  const { confirm } = useConfirm()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(values)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) setDraft(values)
  }, [open, values])

  const dirty = open && !sameList(draft, values)

  const close = () => {
    setOpen(false)
    setDraft(values)
  }

  const requestClose = async () => {
    if (!open) return
    if (dirty) {
      const discard = await confirm({
        title: 'Discard unsaved changes?',
        message: 'You edited the page-size list. Cancel and lose those changes?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      })
      if (!discard) return
    }
    close()
  }

  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  useEffect(() => {
    if (!open) return
    return registerEscapeHandler(() => {
      void requestCloseRef.current()
    })
  }, [open])

  const summary = values.join(', ')

  return (
    <div className="settings-page-size-editor-wrap">
      <div className="settings-option">
        <span className="settings-option-label">{label}</span>
        <div className="settings-option-control">
          <div className="settings-page-size-summary">
            <button
              type="button"
              className={`btn btn-small${open ? ' btn-primary' : ''}`}
              aria-expanded={open}
              onClick={() => {
                if (open) void requestClose()
                else {
                  setDraft(
                    normalizePageSizeOptions(values, min, max, fallback),
                  )
                  setOpen(true)
                }
              }}
            >
              Edit
            </button>
            <span className="settings-page-size-summary-text" title={summary}>
              {summary || '—'}
            </span>
          </div>
        </div>
        {hint && <p className="settings-field-hint settings-option-hint">{hint}</p>}
      </div>

      {open && (
        <div className="settings-page-size-editor panel">
          <SettingsPageSizeList
            values={draft}
            min={min}
            max={max}
            addStep={addStep}
            fallback={fallback}
            onChange={setDraft}
          />
          <div className="settings-page-size-editor-actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={saving}
              onClick={() => void requestClose()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={saving || !dirty}
              onClick={() => {
                void (async () => {
                  const next = normalizePageSizeOptions(draft, min, max, fallback)
                  setSaving(true)
                  try {
                    await onSave(next)
                    setOpen(false)
                  } finally {
                    setSaving(false)
                  }
                })()
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
