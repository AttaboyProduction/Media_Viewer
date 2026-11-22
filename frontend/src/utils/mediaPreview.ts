import type { GridThumbnailSize } from '../types/appSettings'

export type PreviewSize = GridThumbnailSize

/** Snap a rendered card width (CSS pixels) to a cached square size. */
export function previewSizeForTile(tilePx: number): PreviewSize {
  const px = Math.ceil(tilePx * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))
  if (px <= 240) return 'compact'
  if (px <= 360) return 'normal'
  return 'large'
}

export function mediaPreviewUrl(
  id: number,
  size: PreviewSize,
  fileSize?: number | null,
): string {
  const base = `/api/media/${id}/preview?size=${size}`
  if (fileSize == null) return base
  return `${base}&v=${fileSize}`
}
