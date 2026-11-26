import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchScrapeStatus } from '../api/client'
import { notifyScrapeFinished, scrapeUiNotInFocus } from '../utils/scrapeNotification'

/** Poll scrape status app-wide; toast when a job ends while the user is away. */
export default function ScrapeFinishNotifier() {
  const queryClient = useQueryClient()
  const wasRunningRef = useRef(false)

  const { data: status } = useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.running ? 1000 : false),
  })

  useEffect(() => {
    if (wasRunningRef.current && status && !status.running) {
      void queryClient.invalidateQueries({ queryKey: ['duplicates'] })
      void queryClient.invalidateQueries({ queryKey: ['media'] })
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
      void queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
      if (scrapeUiNotInFocus()) {
        void notifyScrapeFinished(status)
      }
    }
    wasRunningRef.current = Boolean(status?.running)
  }, [status, queryClient])

  return null
}