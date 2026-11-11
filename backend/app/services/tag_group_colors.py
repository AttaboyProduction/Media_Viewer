"""Ordered default colors for newly created tag groups.

Palette matches seeded groups from artist → general (by sort_order).
Slots are consumed one-way when a group is created; deleting a group does not restore a slot.
"""

from __future__ import annotations

# artist, character, copyright, meta, system, ai, general
TAG_GROUP_COLOR_PALETTE: list[str] = [
    "#e74c3c",
    "#3498db",
    "#f39c12",
    "#9b59b6",
    "#7f8c8d",
    "#8e44ad",
    "#95a5a6",
]

TAG_GROUP_DEFAULT_COLOR = "#bdc3c7"


def peek_next_tag_group_color(settings: dict) -> str:
    palette = settings.get("tag_group_color_palette") or TAG_GROUP_COLOR_PALETTE
    index = int(settings.get("tag_group_color_next_index", 0))
    default = str(settings.get("tag_group_default_color") or TAG_GROUP_DEFAULT_COLOR)
    if 0 <= index < len(palette):
        return str(palette[index])
    return default


def consume_tag_group_color_slot() -> str:
    """Advance the palette index and return the color that was assigned to this slot."""
    from backend.app.services.app_settings import load_app_settings, save_app_settings

    current = load_app_settings()
    color = peek_next_tag_group_color(current)
    index = int(current.get("tag_group_color_next_index", 0))
    save_app_settings({"tag_group_color_next_index": index + 1})
    return color
