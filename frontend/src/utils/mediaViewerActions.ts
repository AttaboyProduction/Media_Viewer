/** Download / copy helpers for the media detail chrome. */

export function suggestedMediaFilename(
  media: { source_post_id: string; media_type: string; media_url: string },
): string {
  const fromUrl = media.media_url.split('?')[0].split('/').pop() || ''
  if (fromUrl && fromUrl.includes('.')) return fromUrl
  const ext =
    media.media_type === 'video' ? 'mp4' : media.media_type === 'gif' ? 'gif' : 'jpg'
  return `${media.source_post_id || 'media'}.${ext}`
}

export async function downloadMediaFile(url: string, filename: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function saveMediaAs(url: string, filename: string): Promise<void> {
  const picker = (window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName?: string
      types?: { description: string; accept: Record<string, string[]> }[]
    }) => Promise<FileSystemFileHandle>
  }).showSaveFilePicker

  if (typeof picker === 'function') {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Download failed (${res.status})`)
    const blob = await res.blob()
    const handle = await picker({ suggestedName: filename })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return
  }

  await downloadMediaFile(url, filename)
}

/**
 * Copy the full-resolution media file (``media_url``), not a preview.
 * Prefers the original bytes/MIME; only falls back to PNG when the browser
 * refuses the original image type. Never copies a bare URL.
 */
export async function copyMediaToClipboard(
  url: string,
  mediaType: string,
): Promise<'file' | 'image'> {
  if (!navigator.clipboard?.write) {
    throw new Error('Clipboard is not available')
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Copy failed (${res.status})`)
  const blob = await res.blob()
  const mime = blob.type || guessMime(mediaType, url)

  try {
    await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })])
    return 'file'
  } catch {
    // Many browsers only accept image/png on the clipboard.
  }

  if (mime.startsWith('image/') || (mediaType !== 'video' && !mime.startsWith('video/'))) {
    const png = mime === 'image/png' ? blob : await blobToPng(blob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return 'image'
  }

  throw new Error('Could not copy this file to the clipboard')
}

export type ShareMediaResult = 'shared' | 'cancelled' | 'unsupported' | 'downloaded_fallback'

type ShareFileCache = { key: string; file: File }
let shareFileCache: ShareFileCache | null = null

/** True when this browser exposes ``navigator.share`` (file support checked at share time). */
export function canOfferWebShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

function shareCacheKey(url: string, filename: string, mediaType: string): string {
  return `${url}\0${filename}\0${mediaType}`
}

function isShareAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function isShareGestureLost(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'NotAllowedError' || err.name === 'InvalidStateError')
  )
}

async function buildShareFile(url: string, filename: string, mediaType: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Share failed (${res.status})`)
  const blob = await res.blob()
  // iOS Safari rejects empty MIME; always set a concrete type.
  const mime = (blob.type && blob.type !== 'application/octet-stream'
    ? blob.type
    : guessMime(mediaType, url)) || guessMime(mediaType, url)
  return new File([blob], filename, { type: mime })
}

/**
 * Prefetch the share ``File`` while the ⋮ menu is open so the Share click can
 * call ``navigator.share`` without an await first (keeps the user gesture on iOS).
 */
export async function prefetchShareFile(
  url: string,
  filename: string,
  mediaType: string,
): Promise<void> {
  if (!canOfferWebShare()) return
  const key = shareCacheKey(url, filename, mediaType)
  if (shareFileCache?.key === key) return
  const file = await buildShareFile(url, filename, mediaType)
  shareFileCache = { key, file }
}

export function clearShareFileCache(): void {
  shareFileCache = null
}

/** Short hint after downloading when the OS share sheet is unavailable. */
export function shareDownloadFallbackMessage(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPhone|iPad|iPod/i.test(ua)) return 'Downloaded — share from Files or Photos'
  if (/Android/i.test(ua)) return 'Downloaded — share from Files or Downloads'
  return 'Downloaded — open the file to share it'
}

/**
 * Open the OS share sheet with the full-resolution media file.
 * Uses a prefetched file when possible (Android Chrome + iOS Safari).
 * Returns ``cancelled`` when the user dismisses the sheet; ``unsupported`` when
 * Web Share / file sharing is missing (e.g. insecure ``http://LAN`` context).
 */
export async function shareMediaFile(
  url: string,
  filename: string,
  mediaType: string,
): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (typeof navigator.share !== 'function') return 'unsupported'

  const key = shareCacheKey(url, filename, mediaType)
  let file = shareFileCache?.key === key ? shareFileCache.file : null
  if (!file) {
    file = await buildShareFile(url, filename, mediaType)
    shareFileCache = { key, file }
  }

  // Prefer files-only first — iOS Safari is picky about title+files payloads.
  const filesOnly: ShareData = { files: [file] }
  const withTitle: ShareData = { files: [file], title: filename }

  if (typeof navigator.canShare === 'function') {
    if (!navigator.canShare(filesOnly) && !navigator.canShare(withTitle)) {
      return 'unsupported'
    }
  }

  const tryShare = async (data: ShareData) => {
    await navigator.share(data)
    return 'shared' as const
  }

  try {
    if (typeof navigator.canShare !== 'function' || navigator.canShare(filesOnly)) {
      return await tryShare(filesOnly)
    }
    return await tryShare(withTitle)
  } catch (err) {
    if (isShareAbort(err)) return 'cancelled'
    if (isShareGestureLost(err)) return 'unsupported'
    try {
      return await tryShare(withTitle)
    } catch (retryErr) {
      if (isShareAbort(retryErr)) return 'cancelled'
      if (isShareGestureLost(retryErr) || retryErr instanceof TypeError) return 'unsupported'
      throw retryErr
    }
  }
}

/**
 * Share via the OS sheet when possible; otherwise download so phone users can
 * share from Files / Downloads / Photos (common when the page is not a secure context).
 */
export async function shareMediaFileOrDownload(
  url: string,
  filename: string,
  mediaType: string,
): Promise<ShareMediaResult> {
  try {
    const result = await shareMediaFile(url, filename, mediaType)
    if (result !== 'unsupported') return result
  } catch {
    // Fall through to download.
  }
  await downloadMediaFile(url, filename)
  return 'downloaded_fallback'
}

function guessMime(mediaType: string, url: string): string {
  const path = url.split('?')[0].toLowerCase()
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.webm')) return 'video/webm'
  if (mediaType === 'video') return 'video/mp4'
  if (mediaType === 'gif') return 'image/gif'
  return 'image/jpeg'
}

function blobToPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Canvas unavailable'))
          return
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(
          (out) => {
            URL.revokeObjectURL(url)
            if (!out) reject(new Error('PNG encode failed'))
            else resolve(out)
          },
          'image/png',
        )
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Image decode failed'))
    }
    img.src = url
  })
}

export function formatViewerStamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `today at ${time}`
  const month = date.toLocaleString(undefined, { month: 'short' }).toUpperCase()
  const day = date.getDate()
  if (date.getFullYear() === now.getFullYear()) return `${month} ${day} · ${time}`
  return `${month} ${day}, ${date.getFullYear()} · ${time}`
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** 0-based index in a paged list, or -1 when the open id is not on this page. */
export function fileIndexOnPage(
  page: number,
  pageSize: number,
  pageIds: readonly number[],
  mediaId: number,
): number {
  const local = pageIds.indexOf(mediaId)
  if (local < 0 || pageSize <= 0 || page < 1) return -1
  return (page - 1) * pageSize + local
}
