# Viewer tag sidebar

## Mode

`viewer_tag_layout` is `chips` (default) or `sidebar`, under Settings → Viewer → UI.

- **chips:** the existing tag chip filter above the viewer grid is unchanged.
- **sidebar:** the Viewer shows a left column and does not render the chip panel. Selected tags and AND/OR stay on the viewer page and still filter the media list. Select, hide-hidden-tags, and the other page toolbar stay above the content row.

## Sidebar

- Tags are those on media on the current page, grouped by tag group.
- Each group shows at most 10 tags, highest cached file count first, then name. Show more expands that group.
- A click adds the tag to the selection. The row stays in the list with a selected style. Clear is a compact X.
- Search tags, AND/OR, Search groups, and clear use the same compact control size.
- Group titles use the theme foreground color. Tag names use the group color. If that color is too close to the page background, the name gets an outline or a luminance shift so it stays readable in light and dark themes.
- Typeahead search still searches the library, not only the capped page list.

## Counts

`tags.usage_count` stores how many media rows use the tag. It is updated when a media-tag link is added or removed, including scrape, merge, alias cleanup, and media delete. Tag list responses read the column. Settings → Tags has Recalculate tag counts, which rebuilds every count from `media_tags`.

## Search hints

Tag and group search share a typeahead list: the matched text is highlighted, tags show `(count)`, and colors follow the tag or group.

## Settings panels

Collapsible outer panels:

- General: Theme, Display
- Tags: Tags, Hidden tags, Recalculate
- Viewer: UI (layout), then the viewer options that used to live under Other

## Out of scope

Chip display mode stays as it is. Sidebar behavior is not copied back into the chip panel in this change.
