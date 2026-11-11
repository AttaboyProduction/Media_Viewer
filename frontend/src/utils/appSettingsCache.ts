import { DEFAULT_APP_SETTINGS, type AppSettings } from '../types/appSettings'

const STORAGE_KEY = 'scrap_app_settings'

/** Last known settings, so the first render already has the real hide / discarded / page-size values. */
export function readCachedAppSettings(): AppSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    const merged = { ...DEFAULT_APP_SETTINGS } as Record<string, unknown>
    for (const key of Object.keys(DEFAULT_APP_SETTINGS)) {
      const value = parsed[key]
      if (value !== undefined && typeof value === typeof merged[key]) merged[key] = value
    }
    return merged as unknown as AppSettings
  } catch {
    return null
  }
}

export function writeCachedAppSettings(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* quota / private mode */
  }
}
