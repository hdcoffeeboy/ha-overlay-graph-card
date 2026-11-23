# overlay-graph-card — Status & Hand-over

**Source:** `src/overlay-graph-card.js` (vanilla JS custom element). **Build:** `npm run build` (Rollup) → `dist/overlay-graph-card.js` (git-ignored; Chart.js + annotation plugin bundled).
**Version:** set in `package.json`; injected into `CARD_VERSION` at build time.
**Status:** Working, in live testing (author + one other tester). No known open bugs.

## Purpose

Home Assistant Lovelace custom card, similar to `mini-graph-card`, that plots a primary sensor's history and shades background regions according to one or more secondary entities (valve open, compressor running, door open, dryer active, etc.).

## Installation

1. `npm run build`, then copy `dist/overlay-graph-card.js` to `<config>/www/`
2. Add as a Lovelace resource: `/local/overlay-graph-card.js`, type `module`
3. When updating, bump the query string (`?v=N`) to bypass browser cache

## Architecture

| Area | Location (approx. line) | Notes |
|---|---|---|
| `PALETTES`, `palette(graphColor, overlayColor, opacity)` | 45–70 | 7 named colours. Graph and overlay colours resolved independently; overlay falls back to graph colour. |
| Chart.js imports + `Chart.register(...)` | top of file | Bundled Chart.js 4.6.1 + chartjs-plugin-annotation 3.1.0; only needed components registered. |
| `fetchHistory()` | 98 | REST `history/period/...` via `hass.callApi`. Used for primary (when stats off) and all overlays. |
| `fetchStatistics()` | 116 | WebSocket `recorder/statistics_during_period`. Bucket: 5minute (≤48 h), hour (≤168 h), else day. Returns null if entity has no statistics. |
| `resampleToPoints()` / `resampleStats()` | 143 / 168 | Resample onto a uniform 96-point grid (`_POINTS`). **Primary series only.** |
| `smoothArray()` | 199 | Gaussian-weighted rolling average. Half-width = `max(1, round(strength * n * 0.12))`. |
| `buildAnnotationsFromStates()` | 233 | Builds overlay boxes from raw state-change timestamps (not resampled). Supports `threshold`, `invert`, `active_state`. |
| `boxAnnotation()` | 296 | Chart.js annotation box; explicit `xScaleID: "x"`, `yScaleID: "y"`. |
| `autoColor()`, `ON_OFF_DOMAINS` | 317–352 | Picks a colour from domain / entity name when `color: auto`. |
| `OverlayGraphCard` | 353 | Main element. `setConfig` → `_render` (DOM skeleton, legend, tap/hold) → `hass` setter (30 s throttle) → `_updateData` → `_drawChart`. |
| `_handleAction()` | 554 | Tap/hold action dispatcher. |
| `OverlayGraphCardEditor` | `src/editor.js` | Visual editor on HA `ha-form` (entity/icon/ui_action selectors) + per-overlay expansion panels (add, remove, reorder). Shared defaults in `src/const.js`. |

### Data flow

```
hass setter (throttled 30 s)
  → _updateData()
      primary:  fetchStatistics() | fetchHistory() → resample to 96 pts
      overlays: Promise.all(fetchHistory per overlay)   [raw states, no resampling]
  → _drawChart(labels, primaryData, overlayResults, windowStart, windowEnd)
      smoothArray → datasets (line | bar | stats band + mean)
      buildAnnotationsFromStates per overlay → merged annotations (keys ov{i}_r{n})
```

## Configuration reference

```yaml
type: custom:overlay-graph-card
entity: sensor.example            # required
name: Friendly name               # optional
secondary_info: "Subtitle text"   # optional; shown under name, replaces entity ID line
unit: "%"                         # optional; falls back to unit_of_measurement
hours_to_show: 24
color: teal                       # teal|blue|amber|coral|purple|green|red
graph: line                       # line | bar
smoothing: true                   # false/0 = raw; true = 0.2; number 0–1 = strength

overlay:                          # single object OR list; normalised to c.overlays[]
  - entity: valve.example
    label: Watering               # default "Active"
    color: auto                   # named colour | auto | omitted (inherits graph colour)
    opacity: 0.35                 # default 0.35
    invert: false                 # true = highlight when NOT active; legend gets " (off)"
    threshold: 0.1                # numeric entities: active when > threshold
    active_state: ["running"]     # string or list of state strings that count as active

tap_action:  { action: more-info }   # more-info | navigate | toggle | call-service | none
hold_action: { action: none }        # 500 ms hold
  # navigation_path, service, service_data, entity supported per action

show:
  name: true
  icon: true
  entity_id: true                 # hides the line under the title only (see Known issues)
  current_value: true
  legend: true
  extremes: false                 # min/max text under graph
  statistics: false               # min/max band + mean line (needs recorder statistics)
  statistics_opacity: 0.18
```

### Overlay "active" evaluation precedence

`active_state` (if set) → `threshold` (if set) → built-in truthy set (`on, true, 1, open, unlocked, active, running, heating, cooling, fan_only`). `invert` is applied last in every case.

### Entity ID / label resolution

- Title: `name` → `friendly_name` attribute → entity ID
- Line under title: `secondary_info` if set; else entity ID unless `show.entity_id: false`; else nothing (statistics no longer hides it, 2026-11-23)
- Legend primary label: `"Mean"` when statistics on; otherwise `name` → `secondary_info` → entity ID

## Decisions and rationale

- **Overlays use raw timestamps, not the 96-point grid.** Resampling dropped short events (a 30 s valve open in a 24 h window falls between samples). Boxes have a 2 % minimum width so short pulses stay visible.
- **Smoothing is data pre-processing, not Chart.js `tension`.** `cubicInterpolationMode: "monotone"` ignores `tension`, so all non-zero values looked identical. Gaussian pre-smoothing gives a real 0–1 scale. Tester finds 0.2 the sweet spot (≤0.1 leaves jitter), so `true` = 0.2.
- **Window is a fixed fraction of the 96-point grid**, so effective smoothing varies with sensor reporting frequency. Tim is monitoring this across sensors.
- **Single-object `overlay:` remains supported** for back-compat; list form is preferred.
- **Statistics fall back silently** to raw history (mean only) if the entity has no recorded statistics.

## Known issues / limitations

1. **`show.entity_id: false` does not affect the legend.** It only hides the line under the title. The legend falls back to the entity ID only if neither `name` nor `secondary_info` is set; set `name` to avoid it. Tim reported this; the current fix is the name → secondary_info → entity ID chain, not a dedicated switch. **Re-test with the latest build; no dedicated `legend_label` option exists.**
2. **Bar mode only colours bars from the first overlay.** Other overlays still draw as annotation boxes.
3. **Tooltip and bar-colour logic duplicate the active-state evaluation** in three places (`buildAnnotationsFromStates`, tooltip `afterBody`, bar `backgroundColor`) plus a duplicated `TRUTHY` set. Should be refactored into one shared `isOverlayActive(ov, state)`.
4. **Dark mode detection uses `prefers-color-scheme`**, not HA's theme. HA themes that differ from the OS setting will have wrong grid/tick colours.
5. **Y-axis range is auto-calculated** (min/max ± 10 % padding) with no `min`/`max` config.
6. **`navigate` action uses `history.pushState` only**, without dispatching `location-changed`; may not reroute in all HA versions. `more-info` dispatches `hass-more-info`. Both need testing across HA versions.
7. **`hass.callService &&` guard in the `more-info` case** is meaningless and should be removed.
8. **Throttle is a flat 30 s**, independent of `hours_to_show`.
9. **`fetchStatistics` / `statistics_during_period` assumes the recorder WebSocket API shape for the tested HA version**; verify the `types` parameter on older versions.
10. ~~Editor is a stub~~ — visual editor added and live-tested.
11. **`documentationURL` in `window.customCards` is a placeholder** (`https://github.com/your-repo/overlay-graph-card`).
12. **Unverified:** the file has been syntax-checked with Node (the only expected error there is `HTMLElement is not defined`), but runtime behaviour has only been verified by Tim's live HA testing, not by automated tests.

## Bugs fixed this session (for context)

- `generateLabels` declaration accidentally deleted by an edit → syntax error → card not registered
- Overlay shown as a thin sliver → added `xScaleID`/`yScaleID`, raised minimum width to 2 %
- Overlay vanished after switching to list form → stale `this._chart` after `_render()`; now destroyed in `setConfig` and `_lastFetch` reset
- Duplicate "Min / Max range" legend entry
- Valve/switch/cover states (`open`/`closed` etc.) not recognised as active

## Suggested next steps

Prioritised, none started:

1. **Refactor active-state logic** into a single helper (issue 3)
2. **Dedicated legend label option** (e.g. `legend_label`) and make `show.entity_id: false` apply to the legend too (issue 1)
3. **Time-based smoothing** (`smoothing_window` in minutes) to make smoothing consistent across reporting frequencies
4. **Y-axis `min`/`max` config**
5. **Multi-overlay support in bar mode**
6. **HA theme-aware colours** via CSS variables rather than `prefers-color-scheme`
7. **GUI editor.** Estimated 300–400 lines for basics (inputs, selects, toggles, overlay list add/remove), 600–700 with entity pickers and reordering. Uses `<ha-entity-picker>` from the HA frontend, which must be checked for availability before rendering. Fires `config-changed` events. Tim has deferred this pending real-world feedback.
8. **Repo packaging for HACS:** `hacs.json`, README with screenshots, release workflow, bump `CARD_VERSION`, set `documentationURL`
9. **Tests:** extract the pure functions (`buildAnnotationsFromStates`, `smoothArray`, `resample*`) into a testable module

## Test scenarios used so far

- Hanging Garden soil moisture + `valve.hanging_garden_sonoff_swv` ("Watering") + rain overlay, statistics on
- Laundry Humidity with Dryer and Exhaust overlays, tap to toggle bathroom fan
- Planned: rainfall sensor as numeric-threshold overlay

## Working notes

- Work in `src/`; run `npm run build` and copy `dist/overlay-graph-card.js` to HA `<config>/www/` for live testing (bump `?v=` on the resource).
- No runtime network access needed (CDN loading removed 2026-11-23).
- Line numbers in the Architecture table are approximate and pre-date the refactor.

## Session 2026-11-23 (Claude Code) — branch `fix/initial-bugs` (merged via PR #1)

Fixed (code-verified with jsc unit checks; **not yet tested in live HA**):

- Primary series now sampled on the same window grid as overlays and labels (was stretched first→last state). Points before the first record are `null`.
- Active-state logic unified in `makeActiveTest(ov)` + `activeAt()`; bar mode now honours `active_state` (issue 3).
- `loadChartJs` rejects on load failure, retries next refresh, error shown in card; reuses an existing `window.Chart`.
- `connectedCallback` / `disconnectedCallback` destroy and redraw the chart.
- Double registration guarded; `documentationURL` set (issue 11).
- Editor stub removed (HA shows YAML editor); example moved to README (issue 10 remains: no GUI).
- `getStubConfig(hass)` picks a real numeric sensor + binary_sensor.
- Config strings HTML-escaped.
- Tap/hold delegate to HA's `hass-action` event: supports more-info, toggle, navigate, url, perform-action, legacy call-service, confirmation (issues 6, 7).
- Dark mode from `hass.themes.darkMode` (issue 4).
- X labels include weekday (>24 h) or date (>7 d).
- Tooltip/y-axis unit falls back to `unit_of_measurement`.

Notes: Node is not installed; syntax check with `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m overlay-graph-card.js` (expect only `HTMLElement` error).

Live test round 1 (2026-11-23): navigation, theme switch, 72 h weekday labels OK. Failed: no overlays, squashed graph, cluttered rotated x labels, error `e.scales.xAxes.concat`.
- **Cause:** another dashboard card loads Chart.js **v2** onto `window.Chart`; the card reused it. **Fix:** card now loads its own v4 copy + annotation plugin, keeps a private `ChartLib` reference and restores the previous `window.Chart`. (Bundling in step 3 removes this juggling entirely.)
- **X axis:** new `buildTimeTicks()` places ticks at round local times (5 min … 2 weeks steps, ~1 tick per 60 px); midnight shows weekday (≤7 d) or date. Honours HA profile 12/24 h setting via `localeOpts(hass)`.

Live test round 2 (2026-11-23): all checks pass; other chart cards unaffected.

### Live HA test checklist before merge

- Slow-changing sensor (no change for hours): line reaches right edge and aligns with overlays
- Tap more-info, hold toggle with per-action `entity`, navigate
- Navigate away and back; dark/light theme switch
- `hours_to_show: 72` labels
- Round 2: overlays visible incl. currently-active one at right edge; no console error; other Chart.js-v2 card on same dashboard still works; tick spacing at 6 h / 24 h / 72 h; bar mode grid alignment

## Session 2026-11-23 (cont.) — branch `feat/visual-editor` (live-tested OK, ready to merge)

- `src/editor.js`: main form (entity, name, icon, subtitle, unit, hours, graph type, colour, smoothing slider), "Display" (show.*) and "Interactions" (tap/hold via HA `ui_action`) sections, overlay list with add/remove/move.
- Editor writes minimal YAML: defaults omitted, unknown keys preserved, `smoothing: true` kept unless the slider moves. Single-object `overlay:` becomes a list once edited.
- Active states edited as comma-separated text (`heating, cooling` → list).
- ha-form is lazy-loaded by HA; `ensureHaElements()` forces it by opening a built-in card editor.
- Card fixes: `icon` option was ignored (now applied); overlays without an entity are skipped (avoids an unfiltered history fetch while adding one in the editor). `preview: true` in card picker.
- Mapping logic unit-tested in Node; UI untested.
- Live test round 1: OK. Added per-action entity picker (shown for toggle / more-info; writes `tap_action.entity`) and helper note on Display → Entity ID (ignored when Subtitle set or Statistics on).

### Editor live test checklist

- Add card from picker: preview renders, editor opens without errors
- Edit each main field; YAML view matches and stays minimal
- Display and Interactions sections; tap/hold action editors
- Add overlay → pick entity → shading appears; reorder; remove; panel open state survives edits
- Type `heating, cooling` in Active states without characters being eaten
- Existing YAML card (single-object overlay, `smoothing: true`) opens and round-trips unchanged until edited

## HACS release plan

1. ~~Repo + LICENSE~~ (private until release)
2. ~~Fix initial bugs~~ (PR #1)
3. ~~Bundle Chart.js~~ (PR #2) · ~~Visual editor~~ (PR #3)
4. Packaging — branch `chore/hacs-packaging`:
   - ~~`hacs.json`~~ (`filename: overlay-graph-card.js`, `render_readme`; no minimum HA version set yet)
   - ~~Workflows~~: `build.yml` (CI build on push/PR, artifact upload), `validate.yml` (hacs/action, weekly + push/PR), `release.yml` (on release published: version from tag → build → attach asset)
   - ~~README~~: features, HACS + manual install, option tables, release steps
   - **TODO (user):** screenshot `images/card.png` (referenced in README); optional editor screenshot
5. Repo settings before public: description, topics (`home-assistant`, `hacs`, `lovelace`, `custom-card`, `dashboard`), issues enabled.
6. Make public → publish release `v1.0.0` → install via HACS custom repository and test.
7. PR to `hacs/default` (needs ≥1 release, passing HACS action).

Notes: HACS validation may fail while the repo is private or lacks description/topics; that is expected until step 5.
