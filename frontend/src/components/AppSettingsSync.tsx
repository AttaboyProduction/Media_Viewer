import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAppSettings } from '../api/client'
import { writeCachedAppSettings } from '../utils/appSettingsCache'
import { syncDisplayModeFromServer } from '../utils/displayMode'
import {
  applyThemePreference,
  getStoredThemePreference,
  watchSystemTheme,
  type ThemePreference,
} from '../utils/theme'

export default function AppSettingsSync() {
  const { data } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 30_000,
    retry: 3,
  })

  useEffect(() => {
    if (!data) {
      applyThemePreference(getStoredThemePreference())
      return
    }
    applyThemePreference(data.theme as ThemePreference)
    syncDisplayModeFromServer(data.display_mode)
    writeCachedAppSettings(data)
  }, [data])

  useEffect(() => watchSystemTheme(() => undefined), [])

  return null
}
