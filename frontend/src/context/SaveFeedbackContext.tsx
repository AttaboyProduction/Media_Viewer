import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

interface SaveFeedbackContextValue {
  notifySaved: () => void
  savedVisible: boolean
}

const SaveFeedbackContext = createContext<SaveFeedbackContextValue | null>(null)

export function SaveFeedbackProvider({ children }: { children: ReactNode }) {
  const [savedVisible, setSavedVisible] = useState(false)
  const timeoutRef = useRef<number | undefined>(undefined)

  const notifySaved = useCallback(() => {
    setSavedVisible(true)
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = window.setTimeout(() => setSavedVisible(false), 2000)
  }, [])

  return (
    <SaveFeedbackContext.Provider value={{ notifySaved, savedVisible }}>
      {children}
    </SaveFeedbackContext.Provider>
  )
}

export function useSaveFeedback() {
  const ctx = useContext(SaveFeedbackContext)
  if (!ctx) {
    throw new Error('useSaveFeedback must be used within SaveFeedbackProvider')
  }
  return ctx
}

export async function withSavedFeedback(
  notifySaved: () => void,
  action: () => Promise<unknown>,
) {
  await action()
  notifySaved()
}
