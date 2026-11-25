/** Display catalog for Settings → Shortcuts (not editable yet). */

export type ShortcutEntry = {
  group: string
  keys: string
  action: string
}

/**
 * App shortcuts shown in Settings. Main navigation (←/→ between files, page
 * Previous/Next/⇤/⇥, wheel tilt paging) is omitted for now.
 */
export const APP_KEYBOARD_SHORTCUTS: readonly ShortcutEntry[] = [
  {
    group: 'Media detail',
    keys: 'Esc',
    action: 'Close (exits full view or closes URL add first)',
  },
  {
    group: 'Media detail',
    keys: 'Delete',
    action: 'Discard, or Restore when the open file is discarded (confirms)',
  },
  {
    group: 'Media detail',
    keys: 'Ctrl+Delete',
    action: 'Delete permanently (confirms)',
  },
  {
    group: 'Media detail',
    keys: 'F',
    action: 'Toggle full view',
  },
  {
    group: 'Media detail',
    keys: '1–5',
    action: 'Set rating (second digit within 2s for half-stars)',
  },
  {
    group: 'Media detail',
    keys: '↑ / ↓',
    action: 'Scroll the open file or detail panel',
  },
  {
    group: 'Viewer',
    keys: 'Esc',
    action: 'Clear selection (while Select mode is on and no file is open)',
  },
  {
    group: 'Resolve similar',
    keys: 'Esc',
    action: 'Close the resolve overlay',
  },
  {
    group: '⋮ menu / confirm',
    keys: 'Esc',
    action: 'Close the topmost menu or cancel a confirm dialog',
  },
]

export function shortcutGroups(
  entries: readonly ShortcutEntry[] = APP_KEYBOARD_SHORTCUTS,
): { group: string; items: ShortcutEntry[] }[] {
  const order: string[] = []
  const map = new Map<string, ShortcutEntry[]>()
  for (const entry of entries) {
    if (!map.has(entry.group)) {
      order.push(entry.group)
      map.set(entry.group, [])
    }
    map.get(entry.group)!.push(entry)
  }
  return order.map((group) => ({ group, items: map.get(group)! }))
}
