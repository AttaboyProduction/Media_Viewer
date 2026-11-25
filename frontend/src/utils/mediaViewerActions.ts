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

function uniqueFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename)
    return filename
  }
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let n = 2
  let next = `${base} (${n})${ext}`
  while (used.has(next)) {
    n += 1
    next = `${base} (${n})${ext}`
  }
  used.add(next)
  return next
}

export async function downloadMediaFiles(
  files: { url: string; filename: string }[],
): Promise<void> {
  const used = new Set<string>()
  for (const file of files) {
    await downloadMediaFile(file.url, uniqueFilename(file.filename, used))
  }
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

/** Chromium Web Share limits (Windows/Chrome share sheet). */
export const WEB_SHARE_MAX_FILES = 10
export const WEB_SHARE_MAX_BYTES = 50 * 1024 * 1024

export type ShareMediaFilesOutcome = {
  kind: 'shared' | 'cancelled' | 'downloaded_fallback' | 'shared_partial' | 'shared_more'
  sharedCount: number
  downloadedCount: number
  /** Shareable files still selected after this click (need another Share click). */
  remainingCount: number
  /** Indexes into the input files array that were shared on this click. */
  sharedIndexes: number[]
  /** Indexes downloaded this click (too large alone); drop from the selection too. */
  downloadedIndexes: number[]
}

/**
 * Split file sizes into shareable batches under Chromium's file-count and byte caps.
 * Indexes whose size alone exceeds ``maxBytes`` go in ``tooLarge`` (must download).
 */
export function packWebShareBatches(
  sizes: readonly number[],
  maxFiles: number = WEB_SHARE_MAX_FILES,
  maxBytes: number = WEB_SHARE_MAX_BYTES,
): { batches: number[][]; tooLarge: number[] } {
  const batches: number[][] = []
  const tooLarge: number[] = []
  let current: number[] = []
  let bytes = 0
  for (let i = 0; i < sizes.length; i += 1) {
    const size = Math.max(0, sizes[i] ?? 0)
    if (size > maxBytes) {
      if (current.length) {
        batches.push(current)
        current = []
        bytes = 0
      }
      tooLarge.push(i)
      continue
    }
    if (
      current.length > 0 &&
      (current.length >= maxFiles || bytes + size > maxBytes)
    ) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(i)
    bytes += size
  }
  if (current.length) batches.push(current)
  return { batches, tooLarge }
}

export type WebSharePlan = {
  batchCount: number
  firstBatchCount: number
  remainingShareCount: number
  tooLargeCount: number
  totalCount: number
  tooLargeIndexes: number[]
}

export function webSharePlanFromSizes(sizes: readonly number[]): WebSharePlan {
  const { batches, tooLarge } = packWebShareBatches(sizes)
  return {
    batchCount: batches.length,
    firstBatchCount: batches[0]?.length ?? 0,
    remainingShareCount: batches.slice(1).flat().length,
    tooLargeCount: tooLarge.length,
    totalCount: sizes.length,
    tooLargeIndexes: tooLarge,
  }
}

export function webShareNeedsNotice(plan: WebSharePlan): boolean {
  return plan.batchCount > 1 || plan.tooLargeCount > 0
}

/** Copy for each step of the multi-batch share confirm dialog. */
export function webShareStepOptions(args: {
  step: number
  totalSteps: number
  nextCount: number
  remainingShareCount: number
  sharedSoFar: number
  tooLargeCount: number
  oversizedLabels?: string[]
}): {
  title: string
  message: string
  detailLines?: string[]
  confirmLabel: string
  cancelLabel: string
} {
  const {
    step,
    totalSteps,
    nextCount,
    remainingShareCount,
    sharedSoFar,
    tooLargeCount,
    oversizedLabels = [],
  } = args
  const detailLines: string[] = []
  if (totalSteps > 1) {
    detailLines.push(
      `Windows can share at most about 50 MB (and ${WEB_SHARE_MAX_FILES} files) at a time.`,
      `Step ${step} of ${totalSteps}: share ${nextCount} file${nextCount === 1 ? '' : 's'} now` +
        (remainingShareCount > 0
          ? `, then ${remainingShareCount} more after that.`
          : '.'),
    )
  }
  if (tooLargeCount > 0) {
    detailLines.push(
      `${tooLargeCount} file${tooLargeCount === 1 ? '' : 's'} larger than 50 MB cannot be shared and will be downloaded when you finish or stop.`,
    )
    for (const label of oversizedLabels) {
      detailLines.push(label.startsWith('•') ? label : `• ${label}`)
    }
  }
  const multi = totalSteps > 1
  return {
    title: multi
      ? sharedSoFar > 0
        ? 'Continue sharing?'
        : 'Share in multiple steps?'
      : 'Some files are too large to share',
    message: multi
      ? sharedSoFar > 0
        ? `Shared ${sharedSoFar} so far. ${remainingShareCount + nextCount} still need the share sheet.`
        : 'The share sheet can only take part of this selection at once. Use Share next for each batch until everything is done.'
      : 'Files larger than 50 MB cannot be shared through Windows share.',
    detailLines: detailLines.length ? detailLines : undefined,
    confirmLabel: multi ? (sharedSoFar > 0 ? 'Share next' : 'Share next') : 'Download oversized',
    cancelLabel: sharedSoFar > 0 ? 'Stop' : 'Cancel',
  }
}

/** @deprecated Prefer webShareStepOptions for the multi-step dialog. */
export function webShareNoticeOptions(
  plan: WebSharePlan,
  oversizedLabels: string[] = [],
): {
  title: string
  message: string
  detailLines?: string[]
  confirmLabel: string
  cancelLabel: string
} {
  return webShareStepOptions({
    step: 1,
    totalSteps: Math.max(1, plan.batchCount),
    nextCount: plan.firstBatchCount || plan.tooLargeCount,
    remainingShareCount: plan.remainingShareCount,
    sharedSoFar: 0,
    tooLargeCount: plan.tooLargeCount,
    oversizedLabels,
  })
}

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

export type PreparedShareMediaFiles = {
  files: { url: string; filename: string; mediaType: string }[]
  built: File[]
  downloadMeta: { url: string; filename: string }[]
  batches: number[][]
  tooLarge: number[]
  plan: WebSharePlan
}

const emptyShareOutcome = (): ShareMediaFilesOutcome => ({
  kind: 'cancelled',
  sharedCount: 0,
  downloadedCount: 0,
  remainingCount: 0,
  sharedIndexes: [],
  downloadedIndexes: [],
})

/** Fetch share File objects and plan batches (call before the confirm dialog). */
export async function prepareShareMediaFiles(
  files: { url: string; filename: string; mediaType: string }[],
): Promise<PreparedShareMediaFiles> {
  const used = new Set<string>()
  const built: File[] = []
  const downloadMeta: { url: string; filename: string }[] = []
  for (const file of files) {
    const name = uniqueFilename(file.filename, used)
    built.push(await buildShareFile(file.url, name, file.mediaType))
    downloadMeta.push({ url: file.url, filename: name })
  }
  const { batches, tooLarge } = packWebShareBatches(built.map((file) => file.size))
  return {
    files,
    built,
    downloadMeta,
    batches,
    tooLarge,
    plan: webSharePlanFromSizes(built.map((file) => file.size)),
  }
}

/**
 * Open the OS share sheet for one prepared batch.
 * Call this from a fresh button click (confirm dialog) so the user gesture stays valid.
 */
export async function sharePreparedBatch(
  prepared: PreparedShareMediaFiles,
  batchIndex: number,
): Promise<{ status: 'shared' | 'cancelled' | 'failed'; sharedIndexes: number[] }> {
  const indexes = prepared.batches[batchIndex]
  if (!indexes?.length) return { status: 'failed', sharedIndexes: [] }
  if (typeof navigator.share !== 'function') return { status: 'failed', sharedIndexes: [] }

  const batchFiles = indexes.map((i) => prepared.built[i])
  const payload: ShareData = { files: batchFiles }
  if (typeof navigator.canShare === 'function' && !navigator.canShare(payload)) {
    return { status: 'failed', sharedIndexes: [] }
  }
  try {
    await navigator.share(payload)
    return { status: 'shared', sharedIndexes: indexes }
  } catch (err) {
    if (isShareAbort(err)) return { status: 'cancelled', sharedIndexes: [] }
    return { status: 'failed', sharedIndexes: [] }
  }
}

/** Share the first batch only (legacy one-shot path). */
export async function commitShareMediaFiles(
  prepared: PreparedShareMediaFiles,
): Promise<ShareMediaFilesOutcome> {
  const { files, downloadMeta, batches, tooLarge } = prepared
  if (typeof navigator.share !== 'function') {
    await downloadMediaFiles(files)
    return {
      kind: 'downloaded_fallback',
      sharedCount: 0,
      downloadedCount: files.length,
      remainingCount: 0,
      sharedIndexes: [],
      downloadedIndexes: files.map((_, i) => i),
    }
  }

  if (!batches.length) {
    if (tooLarge.length) {
      await downloadMediaFiles(tooLarge.map((i) => downloadMeta[i]))
    }
    return {
      kind: 'downloaded_fallback',
      sharedCount: 0,
      downloadedCount: tooLarge.length || files.length,
      remainingCount: 0,
      sharedIndexes: [],
      downloadedIndexes: tooLarge,
    }
  }

  const result = await sharePreparedBatch(prepared, 0)
  if (result.status === 'cancelled') return emptyShareOutcome()
  if (result.status === 'failed') {
    await downloadMediaFiles(downloadMeta)
    return {
      kind: 'downloaded_fallback',
      sharedCount: 0,
      downloadedCount: files.length,
      remainingCount: 0,
      sharedIndexes: [],
      downloadedIndexes: files.map((_, i) => i),
    }
  }

  if (tooLarge.length) {
    await downloadMediaFiles(tooLarge.map((i) => downloadMeta[i]))
  }

  const sharedCount = result.sharedIndexes.length
  const downloadedCount = tooLarge.length
  const remainingCount = batches.slice(1).flat().length
  if (remainingCount > 0) {
    return {
      kind: 'shared_more',
      sharedCount,
      downloadedCount,
      remainingCount,
      sharedIndexes: result.sharedIndexes,
      downloadedIndexes: tooLarge,
    }
  }
  if (downloadedCount > 0) {
    return {
      kind: 'shared_partial',
      sharedCount,
      downloadedCount,
      remainingCount: 0,
      sharedIndexes: result.sharedIndexes,
      downloadedIndexes: tooLarge,
    }
  }
  return {
    kind: 'shared',
    sharedCount,
    downloadedCount: 0,
    remainingCount: 0,
    sharedIndexes: result.sharedIndexes,
    downloadedIndexes: [],
  }
}

/** Prepare + commit in one step (no confirm dialog). */
export async function shareMediaFiles(
  files: { url: string; filename: string; mediaType: string }[],
): Promise<ShareMediaFilesOutcome> {
  if (files.length === 0) return emptyShareOutcome()
  if (files.length === 1) {
    const file = files[0]
    const result = await shareMediaFileOrDownload(file.url, file.filename, file.mediaType)
    if (result === 'shared') {
      return {
        kind: 'shared',
        sharedCount: 1,
        downloadedCount: 0,
        remainingCount: 0,
        sharedIndexes: [0],
        downloadedIndexes: [],
      }
    }
    if (result === 'cancelled') return emptyShareOutcome()
    return {
      kind: 'downloaded_fallback',
      sharedCount: 0,
      downloadedCount: 1,
      remainingCount: 0,
      sharedIndexes: [],
      downloadedIndexes: [0],
    }
  }
  const prepared = await prepareShareMediaFiles(files)
  return commitShareMediaFiles(prepared)
}

/** Status line after a multi-file share attempt. */
export function shareMediaFilesMessage(outcome: ShareMediaFilesOutcome): string | null {
  if (outcome.kind === 'cancelled') return null
  if (outcome.kind === 'shared') {
    return outcome.sharedCount === 1 ? 'Shared' : `Shared ${outcome.sharedCount} files`
  }
  if (outcome.kind === 'shared_more') {
    const extra =
      outcome.downloadedCount > 0
        ? ` (${outcome.downloadedCount} too large were downloaded)`
        : ''
    return `Shared ${outcome.sharedCount}; ${outcome.remainingCount} left to share${extra}`
  }
  if (outcome.kind === 'shared_partial') {
    return `Shared ${outcome.sharedCount}; downloaded ${outcome.downloadedCount} (too large for share)`
  }
  return shareDownloadFallbackMessage()
}

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

/** Intrinsic pixel size for the detail chrome (e.g. `1920×1080`). */
export function formatPixelSize(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (
    width == null ||
    height == null ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    return ''
  }
  return `${Math.round(width)}×${Math.round(height)}`
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

/**
 * Whether prev/next is available while detail is open.
 * When the open file left the list (filters), `listIndex` is its last known global index.
 */
export function detailCanNavigateAdjacent(
  direction: 'prev' | 'next',
  args: {
    fileIndex: number
    fileTotal: number
    page: number
    totalPages: number
    listIndex: number | null
  },
): boolean {
  const { fileIndex, fileTotal, page, totalPages, listIndex } = args
  if (fileIndex >= 0) {
    return direction === 'next' ? fileIndex < fileTotal - 1 : fileIndex > 0
  }
  if (listIndex == null || fileTotal <= 0) return false
  if (direction === 'next') {
    if (listIndex < fileTotal) return true
    return page < totalPages
  }
  if (listIndex > 0) return true
  return page > 1
}

/** Target global index for prev/next; open file missing from list uses `listIndex`. */
export function targetGlobalIndexForDetailNav(
  direction: 'prev' | 'next',
  fileIndex: number,
  listIndex: number | null,
): number | null {
  if (fileIndex >= 0) {
    return direction === 'next' ? fileIndex + 1 : fileIndex - 1
  }
  if (listIndex == null) return null
  return direction === 'next' ? listIndex : listIndex - 1
}
