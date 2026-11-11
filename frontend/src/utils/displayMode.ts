export const APP_WINDOW_NAME = 'scrap_download_app_window'

export type DisplayMode = 'browser' | 'window'

const STORAGE_KEY = 'scrap_display_mode'

export function getStoredDisplayMode(): DisplayMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'window' || value === 'browser') return value
  } catch {
    /* ignore */
  }
  return 'browser'
}

export function setStoredDisplayMode(mode: DisplayMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }
}

/** Sync display mode from server without opening a new window. */
export function syncDisplayModeFromServer(mode: DisplayMode) {
  setStoredDisplayMode(mode)
}

/** True inside the pywebview / named popup shell (not a normal browser tab). */
export function isDedicatedAppWindow(): boolean {
  if (window.name === APP_WINDOW_NAME) return true
  // pywebview injects this after load; WebView2's UA does not include "WebView".
  if ('pywebview' in window) return true
  const ua = navigator.userAgent
  return /ScrapDownloadApp|WebView|webview/i.test(ua)
}

export function openDedicatedAppWindow(): Window | null {
  const features =
    'width=1280,height=900,menubar=no,toolbar=no,location=no,status=no,resizable=yes'
  // Unique name so a second open does not navigate/reuse an existing popup.
  const name = `${APP_WINDOW_NAME}_${Date.now()}`
  const popup = window.open(window.location.origin, name, features)
  if (popup) {
    try {
      popup.name = APP_WINDOW_NAME
    } catch {
      /* cross-origin / closed */
    }
    popup.focus()
  }
  return popup
}

export async function applyDisplayMode(mode: DisplayMode) {
  setStoredDisplayMode(mode)
  if (mode !== 'window' || isDedicatedAppWindow()) return
  try {
    const { openViewerWindow } = await import('../api/client')
    await openViewerWindow()
  } catch {
    // Fallback if the API/native shell is unavailable.
    openDedicatedAppWindow()
  }
}
