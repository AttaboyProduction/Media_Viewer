import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '../types'
import { registerEscapeHandler } from '../utils/escapeStack'
import {
  clearShareFileCache,
  copyMediaToClipboard,
  downloadMediaFile,
  formatFileSize,
  formatViewerStamp,
  prefetchShareFile,
  saveMediaAs,
  shareDownloadFallbackMessage,
  shareMediaFileOrDownload,
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
  const [statusMs, setStatusMs] = useState(1800)
  const menuRef = useRef<HTMLDivElement>(null)

  const filename = suggestedMediaFilename(media)

  useEffect(() => {
    setMenuOpen(false)
    setStatus('')
    clearShareFileCache()
  }, [media.id])

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    const unregister = registerEscapeHandler(() => setMenuOpen(false))
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      unregister()
    }
  }, [menuOpen])

  // Prefetch while the menu is open so Share keeps the user gesture on iOS/Android.
  useEffect(() => {
    if (!menuOpen) return
    let cancelled = false
    void prefetchShareFile(media.media_url, filename, media.media_type).catch(() => {
      if (!cancelled) {
        /* Prefetch is best-effort; Share click will fetch again. */
      }
    })
    return () => {
      cancelled = true
    }
  }, [menuOpen, media.media_url, media.media_type, filename])

  useEffect(() => {
    if (!status) return
    const t = window.setTimeout(() => setStatus(''), statusMs)
    return () => window.clearTimeout(t)
  }, [status, statusMs])

  const stamp = formatViewerStamp(media.scraped_at)
  const size = formatFileSize(media.file_size)
  const title =
    total > 0 && index >= 0 ? `File ${index + 1} of ${total}` : `File #${media.source_post_id}`
  const subtitle = [stamp, size].filter(Boolean).join(' · ')

  const showStatus = (message: string, ms = 1800) => {
    setStatusMs(ms)
    setStatus(message)
  }

  const run = async (action: () => Promise<void>, okMessage?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      if (okMessage) showStatus(okMessage)
      setMenuOpen(false)
    } catch (err) {
      showStatus(err instanceof Error ? err.message : 'Action failed', 2800)
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
                    const result = await shareMediaFileOrDownload(
                      media.media_url,
                      filename,
                      media.media_type,
                    )
                    if (result === 'cancelled' || result === 'shared') return
                    if (result === 'downloaded_fallback') {
                      showStatus(shareDownloadFallbackMessage(), 4000)
                    }
                  })
                }
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"
                  />
                </svg>
                Share…
              </button>
              <button
                type="button"
                className="modal-viewer-menu-item"
                role="menuitem"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const kind = await copyMediaToClipboard(media.media_url, media.media_type)
                    showStatus(kind === 'file' ? 'Copied file' : 'Copied image')
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
