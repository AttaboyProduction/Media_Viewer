/** LIFO Escape handlers so the topmost UI (modal, confirm, expanded panel) wins. */

type EscapeHandler = () => void

const stack: EscapeHandler[] = []
let listening = false

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (stack.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  stack[stack.length - 1]()
}

function ensureListener() {
  if (listening) return
  listening = true
  document.addEventListener('keydown', onKeyDown, true)
}

/** Register a handler; newest registration is topmost. Returns unregister. */
export function registerEscapeHandler(handler: EscapeHandler): () => void {
  ensureListener()
  stack.push(handler)
  return () => {
    const idx = stack.lastIndexOf(handler)
    if (idx >= 0) stack.splice(idx, 1)
  }
}
