/** Keep a tag color readable against the page background. */

function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.trim().replace('#', '')
  if (raw.length !== 3 && raw.length !== 6) return null
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  const value = Number.parseInt(full, 16)
  if (Number.isNaN(value)) return null
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function channel(n: number): number {
  const s = n / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(rgb: [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const l1 = luminance(a)
  const l2 = luminance(b)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function mix(from: [number, number, number], to: [number, number, number], amount: number): string {
  const mixChannel = (i: number) => Math.round(from[i] + (to[i] - from[i]) * amount)
  const [r, g, b] = [mixChannel(0), mixChannel(1), mixChannel(2)]
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

export function readableTagColor(color: string, background: string, ink: string): string {
  const tag = parseHex(color)
  const bg = parseHex(background)
  const text = parseHex(ink)
  if (!tag || !bg) return color
  if (contrast(tag, bg) >= 3) return color
  if (!text) return color
  let next = tag
  let hex = color
  for (let step = 1; step <= 4; step += 1) {
    hex = mix(next, text, 0.35)
    const parsed = parseHex(hex)
    if (!parsed) return color
    next = parsed
    if (contrast(next, bg) >= 3) return hex
  }
  return hex
}

export function themeSurfaceColors(): { background: string; ink: string } {
  if (typeof document === 'undefined') {
    return { background: '#0f1115', ink: '#e8eaed' }
  }
  const style = getComputedStyle(document.documentElement)
  return {
    background: style.getPropertyValue('--bg-body').trim() || '#0f1115',
    ink: style.getPropertyValue('--text-primary').trim() || '#e8eaed',
  }
}
