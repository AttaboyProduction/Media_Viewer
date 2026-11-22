import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '../types'
import { registerEscapeHandler } from '../utils/escapeStack'
import {
  copyMediaToClipboard,
  downloadMediaFile,
  formatFileSize,
  formatViewerStamp,
  saveMediaAs,
  suggestedMediaFilename,
} from '../utils/mediaViewerActions'

type Props = {
  media: MediaItem
  /** 0-based index in the full filtered / session list. */
  index: number
  total: number
  onRotate: () => void
}

export default function MediaViewerChrome({ media, index, total, onRotate }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMenuOpen(false)
    setStatus('')
  }, [media.id])

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    const unregister = registerEscapeHandler(() => setMenuOpen(false))
    return () => {
      document.removeEventListener('mousedown', onDoc)
      unregister()
    }
  }, [menuOpen])

  useEffect(() => {
    if (!status) return
    const t = window.setTimeout(() => setStatus(''), 1800)
    return () => window.clearTimeout(t)
  }, [status])

  const filename = suggestedMediaFilename(media)
  const stamp = formatViewerStamp(media.scraped_at)
  const size = formatFileSize(media.file_size)
  const title =
    total > 0 && index >= 0 ? `File ${index + 1} of ${total}` : `File #${media.source_post_id}`
  const subtitle = [stamp, size].filter(Boolean).join(' · ')

  const run = async (action: () => Promise<void>, okMessage?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      if (okMessage) setStatus(okMessage)
      setMenuOpen(false)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modal-viewer-info" onClick={(e) => e.stopPropagation()}>
        <div className="modal-viewer-info-title">{title}</div>
        {subtitle ? <div className="modal-viewer-info-sub">{subtitle}</div> : null}
        {status ? <div className="modal-viewer-info-status">{status}</div> : null}
      </div>

      <div className="modal-viewer-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="modal-viewer-action-btn"
          title="Download"
          aria-label="Download"
          disabled={busy}
          onClick={() =>
            void run(() => downloadMediaFile(media.media_url, filename), 'Downloaded')
          }
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M5 20h14v-2H5v2zm7-18v12.17l3.59-3.58L17 12l-5 5-5-5 1.41-1.41L11 14.17V2h1z"
            />
          </svg>
        </button>
        <button
          type="button"
          className="modal-viewer-action-btn"
          title="Rotate counterclockwise"
          aria-label="Rotate counterclockwise"
          disabled={busy}
          onClick={onRotate}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M7.11 8.53 5.7 7.11A7.96 7.96 0 0 0 4 12c0 4.42 3.58 8 8 8v-2c-3.31 0-6-2.69-6-6 0-1.52.57-2.91 1.5-3.99l1.61 1.52zm8.68-5.27L13.41 5.64A5.98 5.98 0 0 1 18 12c0 3.31-2.69 6-6 6v-2.17l-3.59 3.58L12 23l5-5h-3c4.42 0 8-3.58 8-8 0-3.02-1.68-5.65-4.15-7.02l-2.06 1.28z"
            />
          </svg>
        </button>
        <div className="modal-viewer-more" ref={menuRef}>
          <button
            type="button"
            className="modal-viewer-action-btn"
            title="More"
            aria-label="More"
            aria-expanded={menuOpen}
            disabled={busy}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"
              />
            </svg>
          </button>
          {menuOpen ? (
            <div className="modal-viewer-menu" role="menu">
              <button
                type="button"
                className="modal-viewer-menu-item"
                role="menuitem"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const kind = await copyMediaToClipboard(media.media_url, media.media_type)
                    setStatus(kind === 'file' ? 'Copied file' : 'Copied image')
                  })
                }
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"
                  />
                </svg>
                Copy
              </button>
              <button
                type="button"
                className="modal-viewer-menu-item"
                role="menuitem"
                disabled={busy}
                onClick={() =>
                  void run(() => saveMediaAs(media.media_url, filename), 'Saved')
                }
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M5 20h14v-2H5v2zm7-18v12.17l3.59-3.58L17 12l-5 5-5-5 1.41-1.41L11 14.17V2h1z"
                  />
                </svg>
                Save As…
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
