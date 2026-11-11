import { useEffect, useRef } from 'react'
import type { AppSettings } from '../types/appSettings'

export function useApplyAppDefaults(
  data: AppSettings | undefined,
  apply: (settings: AppSettings) => void,
) {
  const applied = useRef(false)
  useEffect(() => {
    if (!data || applied.current) return
    applied.current = true
    apply(data)
  }, [data, apply])
}
