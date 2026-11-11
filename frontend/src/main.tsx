import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { initThemeFromStorage } from './utils/theme'
import { readCachedAppSettings } from './utils/appSettingsCache'
import './index.css'

initThemeFromStorage()

const queryClient = new QueryClient()

const cachedSettings = readCachedAppSettings()
if (cachedSettings) {
  // Render with the last known settings, then revalidate on mount.
  queryClient.setQueryData(['app-settings'], cachedSettings)
  queryClient.invalidateQueries({ queryKey: ['app-settings'] })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
