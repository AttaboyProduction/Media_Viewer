import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import ResolveDuplicatesOverlay from '../components/ResolveDuplicatesOverlay'

interface ResolveDuplicatesContextValue {
  openResolveDuplicates: () => void
  closeResolveDuplicates: () => void
  resolveDuplicatesOpen: boolean
}

const ResolveDuplicatesContext = createContext<ResolveDuplicatesContextValue | null>(null)

export function ResolveDuplicatesProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const openResolveDuplicates = useCallback(() => setOpen(true), [])
  const closeResolveDuplicates = useCallback(() => setOpen(false), [])
  const value = useMemo(
    () => ({
      openResolveDuplicates,
      closeResolveDuplicates,
      resolveDuplicatesOpen: open,
    }),
    [open, openResolveDuplicates, closeResolveDuplicates],
  )

  return (
    <ResolveDuplicatesContext.Provider value={value}>
      {children}
      {open && <ResolveDuplicatesOverlay onClose={closeResolveDuplicates} />}
    </ResolveDuplicatesContext.Provider>
  )
}

export function useResolveDuplicates() {
  const ctx = useContext(ResolveDuplicatesContext)
  if (!ctx) {
    throw new Error('useResolveDuplicates must be used within ResolveDuplicatesProvider')
  }
  return ctx
}
