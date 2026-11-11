# Hide content by tag (blur)

Orthogonal to **Hidden tags** (list exclusion). Matching media stay in grids and detail; previews and full views are **blurred** until the user unlocks the matching rules.

## Goals

- Configure one or more **content hide rules** in Settings (tags + optional reveal message).
- Blur media that match any non-unlocked rule (any of the rule’s tags on the item).
- Unlock is **one-time and persistent**: revealed rule ids are stored in app settings; no “hide again.”
- Reveal from a **blurred card tap** or a **Viewer toolbar** button (after Show/Hide hidden tags).
- Blur on **all** media surfaces: viewer grid, media detail, scrape downloads, related-file picker, duplicate cards.

## Settings

New keys in `app_settings` / `AppSettings` (aligned backend + frontend):

| Key | Shape | Role |
|-----|--------|------|
| `content_hide_rules` | list of `{ id, tag_names, message }` | Rules. `id` is a stable string (uuid). `tag_names` are library tag names. `message` is optional text for the reveal dialog. |
| `content_hide_revealed_rule_ids` | list of rule `id` strings | Rules already unlocked; persist across reloads. |

Settings UI: **Tags** section → panel **Hide content** (alongside Hidden tags).

- List rules; each row: tag multi-select + optional message field.
- Add rule / remove rule.
- Empty `message` still blurs; that rule adds no extra dialog after the first confirm.
- Editing a rule’s tags does not clear its id from `content_hide_revealed_rule_ids` if already revealed (stays unlocked). Removing a rule drops its id from the revealed list on save.

Not a per-tag DB flag. Not tied to `viewer_exclude_*`.

## Matching

- A media item is **locked** if at least one rule in `content_hide_rules` has an id **not** in `content_hide_revealed_rule_ids` and **any** of that rule’s `tag_names` appears on the item’s tags (canonical names already on `MediaItem.tags`).
- Multiple locked rules on one item → stay blurred until **all** matching locked rules are unlocked (or the user runs a flow that unlocks them).

## Reveal flow

Shared helper used by card tap and toolbar:

1. Confirm: **Show hidden content?**
2. For each **applicable** rule that has a non-empty `message`, confirm that message (in list order).
3. On full success, append those rule ids to `content_hide_revealed_rule_ids` via `PATCH /api/settings` and refresh settings cache so all surfaces unblur.
4. Cancel at any step → write nothing.

**Applicable rules**

- **Card tap:** rules that match that card’s tags and are not yet revealed.
- **Toolbar:** all configured rules that are not yet revealed (messages shown only for those with text).

Toolbar label: **Show hidden content** (or similar). Shown when there is at least one rule not yet in `content_hide_revealed_rule_ids`. No hide-again control.

## UI behavior

- Locked media: strong CSS blur over the image/video; videos must not play/autoplay while locked.
- Card: click on the blur overlay starts reveal (does not open detail until unlock succeeds, or if the item has no locked rules). Unlocked cards keep normal open behavior.
- Detail / other surfaces: same blur overlay; clicking it runs the same reveal for rules matching that item.
- Thumbnail/file URLs may still load under blur (accepted for v1); privacy comes from blur + no playback.

## Architecture

| Unit | Responsibility |
|------|----------------|
| Settings normalize/API | Persist and validate `content_hide_rules` / `content_hide_revealed_rule_ids` |
| `contentHide` utils | Match item ↔ rules; list applicable locked rules; pure helpers (testable) |
| `ContentHideProvider` (or settings-driven hooks) | Read rules + revealed ids; `revealRules(ids)` patches settings |
| `ContentHideMedia` wrapper | Blur overlay + click-to-reveal around img/video |
| Settings panel | Edit rules |
| Viewer toolbar | Global reveal for remaining rules |

## Out of scope

- Removing items from lists (existing Hidden tags).
- Server-side blur flags on media summaries.
- Deferring media URL fetch until unlock.
- Per-media reveal memory (only rule ids).
- Re-hiding / clearing revealed ids from the Viewer toolbar (settings can still be edited manually later if needed; no dedicated UI in this change unless the Hide content panel shows revealed state for debugging — not required).

## Testing

- Unit/selftest: match any-tag; locked until all matching rules revealed; empty message skipped in dialog list but still locks.
- Extend settings normalization tests if present; otherwise ask before adding a large harness.
- Manual: Viewer blur/reveal, toolbar, scrape/related/duplicates still blur until rule unlocked.
