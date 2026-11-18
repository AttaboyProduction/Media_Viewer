type TagNode = { tagName: string; isContentEditable?: boolean }

function asTagNode(target: EventTarget | null): TagNode | null {
  if (!target || typeof target !== 'object') return null
  const el = target as { tagName?: unknown; isContentEditable?: boolean }
  if (typeof el.tagName !== 'string') return null
  return el as TagNode
}

/** True when the event is aimed at a real text field the user is typing in. */
export function isKeyboardTypingTarget(target: EventTarget | null): boolean {
  const el = asTagNode(target)
  if (!el) return false
  const tag = el.tagName
  // Media / chrome must never count as "typing" — video focus is the common miss.
  if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'BUTTON') return false
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el.isContentEditable)
}

function pathHasMedia(event: KeyboardEvent): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    const el = asTagNode(node as EventTarget)
    if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) return true
  }
  return false
}

/** Skip app shortcuts only for real typing; never when a video/audio is involved. */
export function shouldSkipKeyboardShortcut(event: KeyboardEvent): boolean {
  if (pathHasMedia(event)) return false
  if (isKeyboardTypingTarget(event.target)) return true
  if (typeof document !== 'undefined' && isKeyboardTypingTarget(document.activeElement)) return true
  return false
}
