import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchScrapeSession } from '../api/client'
import DuplicatesPanel from '../components/DuplicatesPanel'
import RecentScrapedMediaPanel from '../components/RecentScrapedMediaPanel'
import { ScrapeBrowserNotice } from '../components/ScrapeBrowsers'
import ScrapePanel from '../components/ScrapePanel'

export default function ScrapePage() {
  const queryClient = useQueryClient()

  const handleScrapeFinished = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['tags'] })
    queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
    queryClient.invalidateQueries({ queryKey: ['scrape-status'] })
  }, [queryClient])

  const { data: session } = useQuery({
    queryKey: ['scrape-session'],
    queryFn: fetchScrapeSession,
    staleTime: 30_000,
  })
  const showBrowserNotice = session?.selected_source?.kind !== 'local'

  return (
    <div className="page">
      {showBrowserNotice && <ScrapeBrowserNotice />}
      <ScrapePanel onFinished={handleScrapeFinished} />

      <RecentScrapedMediaPanel />
      <DuplicatesPanel />
    </div>
  )
}
