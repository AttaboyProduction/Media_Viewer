/**
 * Layout prefs that stay on this browser (PC vs phone), not in shared app settings.
 * Option lists like viewer_page_sizes stay on the server.
 */
import {
  DEFAULT_APP_SETTINGS,
  type GridThumbnailSize,
  type ViewerSort,
  type ViewerTagLayout,
} from '../types/appSettings'

export type DevicePrefKey =
  | 'viewer_page_size'
  | 'tags_page_size'
  | 'scrape_downloads_page_size'
  | 'grid_thumbnail_size'
  | 'viewer_tag_layout'
  | 'viewer_sort'
  | 'viewer_random_seed'

export type DevicePrefs = {
  viewer_page_size: number
  tags_page_size: number
  scrape_downloads_page_size: number
  grid_thumbnail_size: GridThumbnailSize
  viewer_tag_layout: ViewerTagLayout
  viewer_sort: ViewerSort
  /** 0 = unset; used only while viewer_sort is random. */
  viewer_random_seed: number
}

const STORAGE_KEY = 'scrap_device_prefs'
const GRID_SIZES = new Set<GridThumbnailSize>(['compact', 'normal', 'large'])
const TAG_LAYOUTS = new Set<ViewerTagLayout>(['chips', 'sidebar'])
const VIEWER_SORTS = new Set<ViewerSort>([
  'date_desc',
  'date_asc',
  'rating_desc',
  'rating_asc',
  'random',
])

function readBag(): Partial<DevicePrefs> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as unknown
    return data && typeof data === 'object' ? (data as Partial<DevicePrefs>) : {}
  } catch {
    return {}
  }
}

function writeBag(data: Partial<DevicePrefs>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* private mode / quota */
  }
}

function asInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

export function readDevicePref<K extends DevicePrefKey>(
  key: K,
  fallback: DevicePrefs[K],
  seed?: DevicePrefs[K] | null,
): DevicePrefs[K] {
  const bag = readBag()
  if (Object.prototype.hasOwnProperty.call(bag, key) && bag[key] !== undefined) {
    const parsed = parseDevicePref(key, bag[key], fallback)
    if (parsed !== null) return parsed
  }
  const initial = seed !== undefined && seed !== null ? seed : fallback
  const value = parseDevicePref(key, initial, fallback) ?? fallback
  writeDevicePref(key, value)
  return value
}

export function writeDevicePref<K extends DevicePrefKey>(key: K, value: DevicePrefs[K]): void {
  const bag = readBag()
  bag[key] = value
  writeBag(bag)
}

function parseDevicePref<K extends DevicePrefKey>(
  key: K,
  raw: unknown,
  _fallback: DevicePrefs[K],
): DevicePrefs[K] | null {
  if (key === 'grid_thumbnail_size') {
    return typeof raw === 'string' && GRID_SIZES.has(raw as GridThumbnailSize)
      ? (raw as DevicePrefs[K])
      : null
  }
  if (key === 'viewer_tag_layout') {
    return typeof raw === 'string' && TAG_LAYOUTS.has(raw as ViewerTagLayout)
      ? (raw as DevicePrefs[K])
      : null
  }
  if (key === 'viewer_sort') {
    return typeof raw === 'string' && VIEWER_SORTS.has(raw as ViewerSort)
      ? (raw as DevicePrefs[K])
      : null
  }
  const n = asInt(raw)
  if (n === null) return null
  if (key === 'tags_page_size' && n === 0) return 0 as DevicePrefs[K]
  if (key === 'viewer_random_seed') {
    return n >= 0 ? (n as DevicePrefs[K]) : null
  }
  if (n < 0) return null
  return n as DevicePrefs[K]
}

export function defaultDevicePref<K extends DevicePrefKey>(key: K): DevicePrefs[K] {
  if (key === 'viewer_random_seed') return 0 as DevicePrefs[K]
  return DEFAULT_APP_SETTINGS[key as keyof typeof DEFAULT_APP_SETTINGS] as DevicePrefs[K]
}
