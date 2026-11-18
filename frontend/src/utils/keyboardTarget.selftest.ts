import { isKeyboardTypingTarget, shouldSkipKeyboardShortcut } from './keyboardTarget'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

// jsdom-free stubs: only tagName / isContentEditable matter.
function el(tag: string, editable = false): HTMLElement {
  return { tagName: tag, isContentEditable: editable } as HTMLElement
}

assert(isKeyboardTypingTarget(el('INPUT')) === true, 'input is typing')
assert(isKeyboardTypingTarget(el('TEXTAREA')) === true, 'textarea is typing')
assert(isKeyboardTypingTarget(el('SELECT')) === true, 'select is typing')
assert(isKeyboardTypingTarget(el('DIV', true)) === true, 'contenteditable is typing')
assert(isKeyboardTypingTarget(el('VIDEO')) === false, 'video is not typing')
assert(isKeyboardTypingTarget(el('AUDIO')) === false, 'audio is not typing')
assert(isKeyboardTypingTarget(el('BUTTON')) === false, 'button is not typing')
assert(isKeyboardTypingTarget(el('DIV')) === false, 'plain div is not typing')
assert(isKeyboardTypingTarget(null) === false, 'null is not typing')

function keyEvent(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: el('DIV'),
    composedPath: () => [],
    ...partial,
  } as KeyboardEvent
}

assert(
  shouldSkipKeyboardShortcut(keyEvent({ key: 'f', ctrlKey: true })) === true,
  'Ctrl+F skips app shortcuts',
)
assert(
  shouldSkipKeyboardShortcut(keyEvent({ key: 'f', metaKey: true })) === true,
  'Meta+F skips app shortcuts',
)
assert(
  shouldSkipKeyboardShortcut(keyEvent({ key: 'f' })) === false,
  'plain F does not skip',
)

console.log('keyboardTarget.selftest: ok')
