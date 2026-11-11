import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { fetchAppSettings, patchAppSettings, recalculateTagUsage, type AppSettings } from '../api/client'

import ContentHideRulesEditor from '../components/ContentHideRulesEditor'
import ExcludeTagsPicker from '../components/ExcludeTagsPicker'
import HiddenTagsPicker from '../components/HiddenTagsPicker'
import { ScrapeBrowserList } from '../components/ScrapeBrowsers'
import { SettingsNumberInput } from '../components/SettingsNumberInput'
import { SettingsOption } from '../components/SettingsOption'
import { SettingsPageSizeListEditor } from '../components/SettingsPageSizeListEditor'
import { useSaveFeedback, withSavedFeedback } from '../context/SaveFeedbackContext'

import { applyDisplayMode, syncDisplayModeFromServer } from '../utils/displayMode'

import { registerEscapeHandler } from '../utils/escapeStack'

import { applyThemePreference } from '../utils/theme'

import {
  DEFAULT_APP_SETTINGS,
  TAGS_PAGE_SIZE_MAX,
  TAGS_PAGE_SIZE_MIN,
  TAGS_PAGE_SIZES,
  VIEWER_PAGE_SIZE_MAX,
  VIEWER_PAGE_SIZE_MIN,
  VIEWER_PAGE_SIZES,
} from '../types/appSettings'

export default function AppSettingsPage() {
  const queryClient = useQueryClient()
  const { notifySaved } = useSaveFeedback()
  const [otherOpen, setOtherOpen] = useState(false)
  const [generalOpen, setGeneralOpen] = useState(true)
  const [tagsOpen, setTagsOpen] = useState(true)
  const [viewerOpen, setViewerOpen] = useState(true)

  useEffect(() => {
    if (!otherOpen) return
    return registerEscapeHandler(() => setOtherOpen(false))
  }, [otherOpen])

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    retry: 2,
  })

  const settings = { ...DEFAULT_APP_SETTINGS, ...data }

  const mutation = useMutation({
    mutationFn: patchAppSettings,
    onSuccess: (result) => {
      applyDisplayMode(result.display_mode)
      applyThemePreference(result.theme)
      syncDisplayModeFromServer(result.display_mode)
      queryClient.setQueryData(['app-settings'], result)
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['app-browsers'] })
    },
  })

  const save = async (patch: Partial<AppSettings>) => {
    await withSavedFeedback(notifySaved, () => mutation.mutateAsync(patch))
  }

  const recalc = useMutation({
    mutationFn: recalculateTagUsage,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
  })

  if (isLoading && !data) {
    return (
      <div className="page">
        <div className="empty">Loading settings...</div>
      </div>
    )
  }

  return (
    <div className="page">
      {isError && (
        <div className="banner error">
          Could not load settings. Using defaults for now.{' '}
          <button type="button" className="btn btn-small" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      )}

      <div className="panel panel-collapsible">
        <button
          type="button"
          className="panel-collapse-header"
          onClick={() => setGeneralOpen((v) => !v)}
          aria-expanded={generalOpen}
        >
          <h2>General</h2>
          <span className="panel-collapse-toggle" aria-hidden="true">
            {generalOpen ? '^' : 'v'}
          </span>
        </button>
        {generalOpen && (
          <div className="panel-collapse-body">
      <div className="panel">
        <h2>Theme</h2>
        <p className="settings-hint">
          Choose light or dark appearance, or match your operating system. System follows light or
          dark mode from Windows or browser settings.
        </p>
        <div className="settings-options">
          <label className="settings-radio">
            <input
              type="radio"
              name="theme"
              checked={settings.theme === 'dark'}
              onChange={() => save({ theme: 'dark' })}
            />
            Dark
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="theme"
              checked={settings.theme === 'light'}
              onChange={() => save({ theme: 'light' })}
            />
            Light
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="theme"
              checked={settings.theme === 'system'}
              onChange={() => save({ theme: 'system' })}
            />
            System (default)
          </label>
        </div>
      </div>

      <div className="panel">
        <h2>Display</h2>
        <p className="settings-hint">
          Choose how the viewer opens. Window mode uses a native app window (Windows title bar with
          minimize / maximize / close; no browser chrome). Browser mode opens a normal tab.
        </p>
        <div className="settings-options">
          <label className="settings-radio">
            <input
              type="radio"
              name="display_mode"
              checked={settings.display_mode === 'browser'}
              onChange={() => save({ display_mode: 'browser' })}
            />
            Browser tab (default)
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="display_mode"
              checked={settings.display_mode === 'window'}
              onChange={() => save({ display_mode: 'window' })}
            />
            Separate window (app-style)
          </label>
        </div>
        <SettingsOption
          label="Launch on startup"
          hint="Starts the app when you sign in to Windows (system tray)."
        >
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={settings.launch_on_startup}
              onChange={(e) => save({ launch_on_startup: e.target.checked })}
            />
            Open Scrap Download when Windows starts
          </label>
        </SettingsOption>
        <SettingsOption
          label="Start minimized"
          hint="When on, launching the app starts the server and tray only — no browser/window until you open it from the tray."
        >
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={settings.start_minimized}
              onChange={(e) => save({ start_minimized: e.target.checked })}
            />
            Do not open the viewer on launch (default)
          </label>
        </SettingsOption>
      </div>
          </div>
        )}
      </div>

      <div className="panel panel-collapsible">
        <button
          type="button"
          className="panel-collapse-header"
          onClick={() => setTagsOpen((v) => !v)}
          aria-expanded={tagsOpen}
        >
          <h2>Tags</h2>
          <span className="panel-collapse-toggle" aria-hidden="true">
            {tagsOpen ? '^' : 'v'}
          </span>
        </button>
        {tagsOpen && (
          <div className="panel-collapse-body">
      <div className="panel">
        <h2>Tags</h2>
        <p className="settings-hint">
          When enabled, lists show alternate tag names (for example tag_alias instead of
          tag_name) wherever tags appear.
        </p>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={settings.display_tag_aliases}
            onChange={(e) => save({ display_tag_aliases: e.target.checked })}
          />
          Display tag aliases (default)
        </label>
        <SettingsPageSizeListEditor
          label="Tags per page options"
          hint="Numbers shown in the Tags page dropdown. All is always available and is not listed here."
          values={settings.tags_page_sizes}
          min={TAGS_PAGE_SIZE_MIN}
          max={TAGS_PAGE_SIZE_MAX}
          addStep={25}
          fallback={TAGS_PAGE_SIZES}
          onSave={(next) => save({ tags_page_sizes: next })}
        />
      </div>

      <div className="panel">
        <h2>Hidden tags</h2>
        <p className="settings-hint">
          Hide media in the viewer by tag group or individual tag. The Hide hidden tags button on the
          viewer toggles visibility; its on/off state is saved automatically.
        </p>
        <HiddenTagsPicker
          tagValue={settings.viewer_exclude_tags}
          groupValue={settings.viewer_exclude_tag_groups}
          onChange={(tags, groups) =>
            save({ viewer_exclude_tags: tags, viewer_exclude_tag_groups: groups })
          }
        />
        <button
          type="button"
          className="btn btn-small"
          disabled={recalc.isPending}
          onClick={() => void recalc.mutateAsync()}
        >
          {recalc.isPending ? 'Recalculating…' : 'Recalculate tag counts'}
        </button>
      </div>

      <div className="panel">
        <h2>Hide content</h2>
        <p className="settings-hint">
          Blur previews and full views for media that have any tag in a rule. Reveal is saved in
          settings (Viewer Show hidden content or tap a blurred card). Use Hide again here to
          re-blur a rule or all rules.
        </p>
        <ContentHideRulesEditor
          rules={settings.content_hide_rules}
          revealedRuleIds={settings.content_hide_revealed_rule_ids}
          onChange={(content_hide_rules) => {
            const keep = new Set(content_hide_rules.map((r) => r.id))
            const content_hide_revealed_rule_ids =
              settings.content_hide_revealed_rule_ids.filter((id) => keep.has(id))
            save({ content_hide_rules, content_hide_revealed_rule_ids })
          }}
          onRevealedChange={(content_hide_revealed_rule_ids) =>
            save({ content_hide_revealed_rule_ids })
          }
        />
      </div>
          </div>
        )}
      </div>

      <div className="panel panel-collapsible">
        <button
          type="button"
          className="panel-collapse-header"
          onClick={() => setViewerOpen((v) => !v)}
          aria-expanded={viewerOpen}
        >
          <h2>Viewer</h2>
          <span className="panel-collapse-toggle" aria-hidden="true">
            {viewerOpen ? '^' : 'v'}
          </span>
        </button>
        {viewerOpen && (
          <div className="panel-collapse-body">
            <div className="panel settings-subpanel">
              <h3 className="settings-subpanel-title">UI</h3>
              <SettingsOption
                label="Tag layout"
                hint="Chips keeps the tag filter above the grid. Sidebar lists current-page tags on the left."
              >
                <select
                  value={settings.viewer_tag_layout}
                  onChange={(e) =>
                    save({
                      viewer_tag_layout: e.target.value as AppSettings['viewer_tag_layout'],
                    })
                  }
                >
                  <option value="chips">Chips above the grid</option>
                  <option value="sidebar">Left sidebar</option>
                </select>
              </SettingsOption>
            </div>
            <div className="panel settings-subpanel">
              <h3 className="settings-subpanel-title">Viewer</h3>
              <SettingsOption label="Default sort">
                <select
                  value={settings.viewer_sort}
                  onChange={(e) => save({ viewer_sort: e.target.value as AppSettings['viewer_sort'] })}
                >
                  <option value="date_desc">Newest</option>
                  <option value="date_asc">Oldest</option>
                  <option value="rating_desc">Highest rated</option>
                  <option value="rating_asc">Lowest rated</option>
                  <option value="random">Random</option>
                </select>
              </SettingsOption>
              <SettingsOption label="Show discarded">
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.viewer_include_discarded}
                    onChange={(e) => save({ viewer_include_discarded: e.target.checked })}
                  />
                  Include discarded media by default
                </label>
              </SettingsOption>
              <SettingsOption label="Grid thumbnail size">
                <select
                  value={settings.grid_thumbnail_size}
                  onChange={(e) =>
                    save({
                      grid_thumbnail_size: e.target.value as AppSettings['grid_thumbnail_size'],
                    })
                  }
                >
                  <option value="compact">Compact</option>
                  <option value="normal">Normal</option>
                  <option value="large">Large</option>
                </select>
              </SettingsOption>
              <SettingsOption
                label="Grid videos"
                hint="When off, videos play only while the pointer hovers the preview."
              >
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.grid_video_autoplay}
                    onChange={(e) => save({ grid_video_autoplay: e.target.checked })}
                  />
                  Autoplay all videos in grid (loop)
                </label>
              </SettingsOption>
              <SettingsOption label="Open media detail">
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.media_open_on_double_click}
                    onChange={(e) => save({ media_open_on_double_click: e.target.checked })}
                  />
                  Require double-click to open (single-click when off)
                </label>
              </SettingsOption>
              <SettingsOption
                label="Media number"
                hint="Source = site post id. Database = internal row id."
              >
                <select
                  value={settings.viewer_media_numbering}
                  onChange={(e) =>
                    save({
                      viewer_media_numbering: e.target.value as AppSettings['viewer_media_numbering'],
                    })
                  }
                >
                  <option value="source">Source post number</option>
                  <option value="db">Database ID</option>
                </select>
              </SettingsOption>
              <SettingsOption
                label="Media detail tags"
                hint="When on, media detail shows the first 25 tags and a dark Show more (+N) chip."
              >
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.media_detail_tags_collapsed}
                    onChange={(e) => save({ media_detail_tags_collapsed: e.target.checked })}
                  />
                  Collapse tags by default
                </label>
              </SettingsOption>
              <SettingsPageSizeListEditor
                label="Items per page options"
                hint="Numbers shown in the Viewer page-size dropdown. The live size is still chosen on the Viewer."
                values={settings.viewer_page_sizes}
                min={VIEWER_PAGE_SIZE_MIN}
                max={VIEWER_PAGE_SIZE_MAX}
                addStep={12}
                fallback={VIEWER_PAGE_SIZES}
                onSave={(next) => save({ viewer_page_sizes: next })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="panel panel-collapsible">
        <button
          type="button"
          className="panel-collapse-header"
          onClick={() => setOtherOpen((v) => !v)}
          aria-expanded={otherOpen}
        >
          <h2>Other</h2>
          <span className="panel-collapse-toggle" aria-hidden="true">
            {otherOpen ? '^' : 'v'}
          </span>
        </button>
        {otherOpen && (
          <div className="panel-collapse-body">
            <div className="panel settings-subpanel">
              <h3 className="settings-subpanel-title">Scrape</h3>
              <SettingsOption
                label="Hide Scrape page"
                hint="While hidden, scraping is off: no Rescrape or Update tags in media detail, and scrape browsers are not checked or updated at startup."
              >
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.hide_scrape_page}
                    onChange={(e) => save({ hide_scrape_page: e.target.checked })}
                  />
                  Hide Scrape page in navigation (default)
                </label>
              </SettingsOption>
              {!settings.hide_scrape_page && (
                <>
                  <SettingsOption
                    label="Skip identical files"
                    hint="A new post that matches a library file in the identical band is not downloaded. Its tags and URL are added to the kept file. Similar files are still downloaded."
                  >
                    <label className="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={settings.scrape_skip_identical}
                        onChange={(e) => save({ scrape_skip_identical: e.target.checked })}
                      />
                      Skip identical downloads
                    </label>
                  </SettingsOption>
                  <SettingsOption label="Default limit">
                    <SettingsNumberInput
                      value={settings.scrape_default_limit}
                      min={0}
                      max={500}
                      onCommit={(n) => save({ scrape_default_limit: n })}
                    />
                  </SettingsOption>
                  <SettingsOption label="Default sort">
                    <select
                      value={settings.scrape_default_sort}
                      onChange={(e) =>
                        save({ scrape_default_sort: e.target.value as AppSettings['scrape_default_sort'] })
                      }
                    >
                      <option value="date_desc">Newest first</option>
                      <option value="date_asc">Oldest first</option>
                    </select>
                  </SettingsOption>
                  <SettingsOption label="Default exclude tags">
                    <ExcludeTagsPicker
                      value={settings.scrape_default_exclude_tags}
                      onChange={(next) => save({ scrape_default_exclude_tags: next })}
                    />
                  </SettingsOption>
                  <div className="panel settings-subpanel">
                    <h3 className="settings-subpanel-title">Scrape browser</h3>
                    <p className="settings-hint">
                      Browser used to open site pages while scraping. Auto picks Obscura when it is
                      installed and Playwright Chromium otherwise.
                    </p>
                    <SettingsOption
                      label="Check for updates on start"
                      hint="Installed scrape browsers, at most once a day. Off by default when Windows reports a metered connection."
                    >
                      <label className="settings-checkbox">
                        <input
                          type="checkbox"
                          checked={settings.check_browser_updates_on_start}
                          onChange={(e) => save({ check_browser_updates_on_start: e.target.checked })}
                        />
                        Check for browser updates when the app starts
                      </label>
                    </SettingsOption>
                    <ScrapeBrowserList
                      value={settings.scrape_browser}
                      onChange={(next) => save({ scrape_browser: next })}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="panel settings-subpanel">
              <h3 className="settings-subpanel-title">Tags &amp; duplicates</h3>
              <SettingsOption
                label="Untyped site tags"
                hint="When the site does not send a tag type (or HTML has no group class), assign the current default tag group or Unknown."
              >
                <select
                  value={settings.tags_untyped_group}
                  onChange={(e) =>
                    save({
                      tags_untyped_group: e.target.value as AppSettings['tags_untyped_group'],
                    })
                  }
                >
                  <option value="default">Default tag group</option>
                  <option value="unknown">Unknown group</option>
                </select>
              </SettingsOption>
              <SettingsOption
                label="Sort tags within groups"
                hint="Viewer and tag lists: order by tag name or by each tag’s order number."
              >
                <select
                  value={settings.tags_sort_mode}
                  onChange={(e) =>
                    save({
                      tags_sort_mode: e.target.value as AppSettings['tags_sort_mode'],
                    })
                  }
                >
                  <option value="order">Order</option>
                  <option value="name">Name</option>
                </select>
              </SettingsOption>
              <SettingsOption
                label="Selected tags display"
                hint="Viewer filters and tag/group pickers: how selected chips are shown."
              >
                <select
                  value={settings.tags_select_display_mode}
                  onChange={(e) =>
                    save({
                      tags_select_display_mode: e.target
                        .value as AppSettings['tags_select_display_mode'],
                    })
                  }
                >
                  <option value="panel">Move to panel above list</option>
                  <option value="front">Highlight and move to front of list</option>
                  <option value="highlight">Highlight in list only</option>
                </select>
              </SettingsOption>
              <SettingsOption
                label="New tag / group order"
                hint="When Order is left empty on Add tags or Add tag group: insert alphabetically by name (with shift), or append at the end."
              >
                <select
                  value={settings.tags_auto_order_mode}
                  onChange={(e) =>
                    save({
                      tags_auto_order_mode: e.target.value as AppSettings['tags_auto_order_mode'],
                    })
                  }
                >
                  <option value="by_name">Insert by name</option>
                  <option value="end">Add at end</option>
                </select>
              </SettingsOption>
              <SettingsOption
                label="Similar image sensitivity"
                hint="Hamming distance. 0–2 (within this cap) counts as Identical (same picture, including different resolution). Higher values also catch crops and watermarks as Similar."
              >
                <SettingsNumberInput
                  value={settings.phash_threshold}
                  min={1}
                  max={32}
                  onCommit={(n) => save({ phash_threshold: n })}
                />
              </SettingsOption>
            </div>
          </div>
        )}
      </div>

      {mutation.isError && (
        <div className="error">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to save settings'}
        </div>
      )}
    </div>
  )
}
