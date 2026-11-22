import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { registerEscapeHandler } from '../utils/escapeStack'

export interface ConfirmOptions {
  title?: string
  message: string
  /** Extra lines (paths, etc.) shown in a scrollable block that grows with the text. */
  detailLines?: string[]
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface PendingConfirm {
  options: ConfirmOptions
  resolve: (confirmed: boolean) => void
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ options, resolve })
    })
  }, [])

  const close = (result: boolean) => {
    if (!pending) return
    pending.resolve(result)
    setPending(null)
  }

  useEffect(() => {
    if (!pending) return

    const unregisterEsc = registerEscapeHandler(() => close(false))
    confirmButtonRef.current?.focus()
    return unregisterEsc
  }, [pending])

  const options = pending?.options
  const confirmLabel = options?.confirmLabel ?? (options?.danger ? 'Delete' : 'Confirm')
  const cancelLabel = options?.cancelLabel ?? 'Cancel'

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {pending && options && (
        <div className="confirm-backdrop" onClick={() => close(false)}>
          <div
            className={`confirm-dialog${options.detailLines?.length ? ' confirm-dialog--detail' : ''}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
            onClick={(e) => e.stopPropagation()}
          >
            {options.title && (
              <h3 id="confirm-dialog-title" className="confirm-dialog-title">
                {options.title}
              </h3>
            )}
            <p id="confirm-dialog-message" className="confirm-dialog-message">
              {options.message}
            </p>
            {options.detailLines && options.detailLines.length > 0 ? (
              <div className="confirm-dialog-detail" tabIndex={0}>
                <ul className="confirm-dialog-detail-list">
                  {options.detailLines.map((line, index) => (
                    <li key={`${index}:${line}`} title={line}>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="confirm-dialog-actions">
              <button type="button" className="btn" onClick={() => close(false)}>
                {cancelLabel}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className={`btn${options.danger ? ' btn-danger' : ' btn-primary'}`}
                onClick={() => close(true)}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useConfirm must be used within ConfirmProvider')
  }
  return ctx
}
