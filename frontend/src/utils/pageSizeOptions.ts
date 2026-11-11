/** Unique positive ints in [min, max], sorted ascending. Empty → fallback. */
export function normalizePageSizeOptions(
  values: readonly number[],
  min: number,
  max: number,
  fallback: readonly number[],
): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const raw of values) {
    if (!Number.isFinite(raw)) continue
    const n = Math.trunc(raw)
    if (n < min || n > max || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  out.sort((a, b) => a - b)
  return out.length > 0 ? out : [...fallback]
}

/** Keep current if allowed; else prefer default when present; else first option. */
export function clampPageSizeToOptions(
  current: number,
  options: readonly number[],
  defaultSize: number,
  allowZero = false,
): number {
  const allowed = new Set(options)
  if (allowZero) allowed.add(0)
  if (allowed.has(current)) return current
  if (allowed.has(defaultSize)) return defaultSize
  return options[0] ?? defaultSize
}

/** Suggest a new size not already in the list (prefer last+step, else min). */
export function suggestNextPageSize(
  values: readonly number[],
  min: number,
  max: number,
  step: number,
): number {
  const last = values.length > 0 ? Math.max(...values) : min - step
  const candidate = Math.min(max, last + step)
  if (candidate >= min && !values.includes(candidate)) return candidate
  for (let n = min; n <= max; n++) {
    if (!values.includes(n)) return n
  }
  return min
}
