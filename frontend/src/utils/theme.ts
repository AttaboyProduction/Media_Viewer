export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'scrap_theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function getStoredThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    /* ignore */
  }
  return 'system'
}

export function setStoredThemePreference(theme: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* ignore */
  }
}

export function resolveSystemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return resolveSystemTheme()
  return preference
}

export function applyResolvedTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.style.colorScheme = resolved
}

export function applyThemePreference(preference: ThemePreference) {
  setStoredThemePreference(preference)
  applyResolvedTheme(resolveTheme(preference))
}

export function initThemeFromStorage() {
  applyThemePreference(getStoredThemePreference())
}

export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  const media = window.matchMedia(DARK_QUERY)
  const handler = () => {
    if (getStoredThemePreference() === 'system') {
      const resolved = resolveSystemTheme()
      applyResolvedTheme(resolved)
      onChange(resolved)
    }
  }
  media.addEventListener('change', handler)
  return () => media.removeEventListener('change', handler)
}
