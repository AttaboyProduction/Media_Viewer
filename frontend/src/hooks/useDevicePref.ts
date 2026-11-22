import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultDevicePref,
  readDevicePref,
  writeDevicePref,
  type DevicePrefKey,
  type DevicePrefs,
} from '../utils/devicePrefs'

/** One layout preference stored only in this browser. */
export function useDevicePref<K extends DevicePrefKey>(
  key: K,
  options?: {
    /** Wait until true before seeding (e.g. shared settings have loaded). */
    ready?: boolean
    /** First-time seed from shared settings; ignored once this browser has a value. */
    seed?: DevicePrefs[K] | null
  },
): [DevicePrefs[K], (next: DevicePrefs[K]) => void] {
  const ready = options?.ready ?? true
  const seed = options?.seed
  const applied = useRef(false)
  const [value, setValue] = useState<DevicePrefs[K]>(() => defaultDevicePref(key))

  useEffect(() => {
    if (!ready || applied.current) return
    applied.current = true
    setValue(readDevicePref(key, defaultDevicePref(key), seed ?? null))
  }, [key, ready, seed])

  const setPersisted = useCallback(
    (next: DevicePrefs[K]) => {
      writeDevicePref(key, next)
      setValue(next)
    },
    [key],
  )

  return [value, setPersisted]
}
