/**
 * overlay-graph-card
 * Home Assistant Lovelace card that plots a sensor's history and shades
 * background regions while one or more other entities are active.
 *
 * Source file – build with `npm run build` to produce
 * dist/overlay-graph-card.js. Configuration: see README.md.
 */

import {
  Chart,
  LineController, BarController,
  LineElement, BarElement, PointElement,
  CategoryScale, LinearScale,
  Filler, Tooltip,
} from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";
import { SHOW_DEFAULTS, OVERLAY_DEFAULTS, ACTION_DEFAULTS, smoothingStrength } from "./const.js";
import { OverlayGraphCardEditor } from "./editor.js";

// Replaced at build time from package.json
const CARD_VERSION = __CARD_VERSION__;

// ---------------------------------------------------------------------------
// Color palettes – one per named theme
// ---------------------------------------------------------------------------
const PALETTES = {
  teal:   { line: "#1D9E75", fill: "rgba(29,158,117,0.13)",  overlay: "rgba(29,158,117,{A})",  border: "#0F6E56" },
  blue:   { line: "#378ADD", fill: "rgba(55,138,221,0.13)",  overlay: "rgba(55,138,221,{A})",  border: "#185FA5" },
  amber:  { line: "#BA7517", fill: "rgba(186,117,23,0.13)",  overlay: "rgba(239,159,39,{A})",  border: "#854F0B" },
  coral:  { line: "#D85A30", fill: "rgba(216,90,48,0.13)",   overlay: "rgba(216,90,48,{A})",   border: "#993C1D" },
  purple: { line: "#7F77DD", fill: "rgba(127,119,221,0.13)", overlay: "rgba(127,119,221,{A})", border: "#534AB7" },
  green:  { line: "#639922", fill: "rgba(99,153,34,0.13)",   overlay: "rgba(99,153,34,{A})",   border: "#3B6D11" },
  red:    { line: "#E24B4A", fill: "rgba(226,75,74,0.13)",   overlay: "rgba(226,75,74,{A})",   border: "#A32D2D" },
};

function palette(graphColor, overlayColor, overlayOpacity = 0.22) {
  const gp = PALETTES[graphColor] || PALETTES.teal;
  const op = PALETTES[overlayColor] || gp; // fall back to graph colour
  return {
    // graph line + fill
    line:             gp.line,
    fill:             gp.fill,
    // overlay annotation
    overlayResolved:  op.overlay.replace("{A}", overlayOpacity),
    border:           op.border,
  };
}

// ---------------------------------------------------------------------------
// Chart.js – bundled at build time (see rollup.config.mjs). Only the parts
// this card uses are registered, on a private instance that never touches
// window.Chart, so other cards' Chart.js versions can't interfere.
// ---------------------------------------------------------------------------
Chart.register(
  LineController, BarController,
  LineElement, BarElement, PointElement,
  CategoryScale, LinearScale,
  Filler, Tooltip,
  annotationPlugin,
);

// ---------------------------------------------------------------------------
// Overlay "active" evaluation – single source of truth
// Precedence: active_state → threshold → built-in truthy set; invert last.
// ---------------------------------------------------------------------------
const TRUTHY = new Set(["on","true","1","open","unlocked","active","running","heating","cooling","fan_only"]);

function makeActiveTest(ov) {
  const activeStates = ov.active_state != null
    ? new Set((Array.isArray(ov.active_state) ? ov.active_state : [ov.active_state]).map(String))
    : null;
  const threshold = ov.threshold != null ? Number(ov.threshold) : null;
  return (state) => {
    let result;
    if (activeStates) {
      result = activeStates.has(state);
    } else if (threshold != null) {
      const v = parseFloat(state);
      result = !isNaN(v) && v > threshold;
    } else {
      result = TRUTHY.has(state);
    }
    return ov.invert ? !result : result;
  };
}

// Is the overlay active at time t (ms)? states must be sorted by last_changed.
function activeAt(states, isActive, t) {
  let active = false;
  for (let s = 0; s < states.length; s++) {
    if (new Date(states[s].last_changed).getTime() > t) break;
    active = isActive(states[s].state);
  }
  return active;
}

// ---------------------------------------------------------------------------
// History fetching helpers
// ---------------------------------------------------------------------------
async function fetchHistory(hass, entityId, windowStart, windowEnd) {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  const url =
    `history/period/${start.toISOString()}?filter_entity_id=${encodeURIComponent(entityId)}` +
    `&end_time=${end.toISOString()}&minimal_response=true&no_attributes=true`;
  try {
    const result = await hass.callApi("GET", url);
    return Array.isArray(result) && result.length ? result[0] : [];
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Statistics fetching (recorder – gives min/max/mean per bucket)
// Falls back gracefully if the entity has no long-term statistics recorded.
// ---------------------------------------------------------------------------
async function fetchStatistics(hass, entityId, windowStart, windowEnd) {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  const hoursToShow = (windowEnd - windowStart) / 3600000;
  // Choose bucket size: ≤48 h → 5 min, ≤7 days → hour, else day
  const period = hoursToShow <= 48 ? "5minute" : hoursToShow <= 168 ? "hour" : "day";
  try {
    const result = await hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [entityId],
      period,
      types: ["mean", "min", "max"],
    });
    const rows = result[entityId];
    if (!rows || !rows.length) return null;
    return rows.map((r) => ({
      t: new Date(r.start).getTime(),
      mean: r.mean ?? null,
      min:  r.min  ?? null,
      max:  r.max  ?? null,
    }));
  } catch (_) {
    return null; // entity not in recorder – caller falls back to raw history
  }
}

// Time of grid point i on a uniform grid spanning [windowStart, windowEnd]
function gridTime(i, count, windowStart, windowEnd) {
  return windowStart + (i / (count - 1)) * (windowEnd - windowStart);
}

// Sample a numeric state history onto the window grid. Each state holds until
// the next change (or until now); points before the first record are null.
function resampleToPoints(states, count, windowStart, windowEnd) {
  if (!states.length) return Array(count).fill(null);
  const times = states.map((s) => new Date(s.last_changed).getTime());
  const out = [];
  let si = -1;
  for (let i = 0; i < count; i++) {
    const t = gridTime(i, count, windowStart, windowEnd);
    while (si < states.length - 1 && times[si + 1] <= t) si++;
    if (si < 0) { out.push(null); continue; }
    const v = parseFloat(states[si].state);
    out.push(isNaN(v) ? null : v);
  }
  return out;
}

function resampleStats(rows, count, windowStart, windowEnd) {
  // rows: [{t, mean, min, max}] – may be sparse; step-sample onto uniform grid
  const means = [], mins = [], maxs = [];
  let ri = -1;
  for (let i = 0; i < count; i++) {
    const t = gridTime(i, count, windowStart, windowEnd);
    while (ri < rows.length - 1 && rows[ri + 1].t <= t) ri++;
    const r = ri >= 0 ? rows[ri] : null;
    means.push(r ? r.mean : null);
    mins.push(r ? r.min : null);
    maxs.push(r ? r.max : null);
  }
  return { means, mins, maxs };
}

// Locale + 12/24 h preference from the HA user profile
function localeOpts(hass) {
  const loc = (hass && hass.locale) || {};
  const opts = { locale: loc.language || [] };
  if (loc.time_format === "12") opts.hour12 = true;
  else if (loc.time_format === "24") opts.hour12 = false;
  return opts;
}

function fmtDate(t, lo, fmt) {
  const o = { ...fmt };
  if (lo.hour12 !== undefined && (fmt.hour || fmt.minute)) o.hour12 = lo.hour12;
  try {
    return new Date(t).toLocaleString(lo.locale, o);
  } catch (_) {
    return new Date(t).toLocaleString([], o);
  }
}

// Tooltip titles, one per grid point
function generateLabels(windowStart, windowEnd, count, lo) {
  const hours = (windowEnd - windowStart) / 3600000;
  const fmt = hours <= 24
    ? { hour: "2-digit", minute: "2-digit" }
    : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return Array.from({ length: count }, (_, i) =>
    fmtDate(gridTime(i, count, windowStart, windowEnd), lo, fmt)
  );
}

// X-axis ticks at round local clock times. Picks the smallest "nice" step
// that keeps the tick count ≤ maxTicks. Returns [{pos, label}] where pos is
// in the chart's index space (0 … points-1).
const TICK_STEPS_MIN = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 10080, 20160];

function buildTimeTicks(windowStart, windowEnd, points, maxTicks, lo) {
  const spanMin = (windowEnd - windowStart) / 60000;
  const step = TICK_STEPS_MIN.find((s) => spanMin / s <= maxTicks) || TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1];
  const multiDay = spanMin > 1440;
  // Start from local midnight on the day the window starts (week steps: Monday)
  const d = new Date(windowStart);
  d.setHours(0, 0, 0, 0);
  if (step >= 10080) d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const ticks = [];
  while (d.getTime() <= windowEnd) {
    const t = d.getTime();
    if (t >= windowStart) {
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      let label;
      if (!multiDay || !midnight) {
        label = fmtDate(t, lo, { hour: "2-digit", minute: "2-digit" });
      } else if (spanMin <= 7 * 1440) {
        label = fmtDate(t, lo, { weekday: "short" });
      } else {
        label = fmtDate(t, lo, { day: "numeric", month: "short" });
      }
      ticks.push({ pos: ((t - windowStart) / (windowEnd - windowStart)) * (points - 1), label });
    }
    // Step in local time so DST changes keep ticks on round hours
    if (step >= 1440) d.setDate(d.getDate() + step / 1440);
    else d.setMinutes(d.getMinutes() + step);
  }
  return ticks;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

// ---------------------------------------------------------------------------
// Gaussian-weighted rolling average.
// strength 0 = no change, 1 = fully smoothed.
// Window size scales with strength so low values give subtle rounding
// and high values wash out fine detail the way HA's sensor card does.
// ---------------------------------------------------------------------------
function smoothArray(data, strength) {
  if (!strength || strength <= 0) return data;
  const n = data.length;
  // Window half-width: 1 point at strength=0.1, up to ~12% of series at strength=1
  const hw = Math.max(1, Math.round(strength * n * 0.12));
  // Build Gaussian weights
  const sigma = hw / 2;
  const weights = [];
  for (let i = -hw; i <= hw; i++) {
    weights.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  }
  const wSum = weights.reduce((a, b) => a + b, 0);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let val = 0, w = 0;
    for (let j = -hw; j <= hw; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < n && data[idx] !== null) {
        val += data[idx] * weights[j + hw];
        w   += weights[j + hw];
      }
    }
    out[i] = w > 0 ? val / w : data[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build annotation spans directly from raw state-change records.
// Works at full timestamp resolution – no resampling, no lost short pulses.
// Returns a Chart.js annotations object keyed r0, r1, …
// xMin/xMax are expressed in the label-index space (0 … POINTS-1).
// A minimum visual width of MIN_FRAC * POINTS prevents sub-pixel spans.
// ---------------------------------------------------------------------------
function buildAnnotationsFromStates(ovStates, windowStart, windowEnd, pal, points, isActive) {
  if (!ovStates || !ovStates.length) return {};
  const span = windowEnd - windowStart || 1;
  const MIN_FRAC = 0.02;
  const minWidth = MIN_FRAC * points;

  // Convert timestamps → fractional axis positions
  function toX(isoOrMs) {
    const t = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
    return ((t - windowStart) / span) * (points - 1);
  }

  const annotations = {};
  let runStart = null;
  let idx = 0;

  // Walk every state-change record
  for (let i = 0; i < ovStates.length; i++) {
    const active = isActive(ovStates[i].state);
    const tStart = new Date(ovStates[i].last_changed).getTime();
    const tEnd   = i + 1 < ovStates.length
      ? new Date(ovStates[i + 1].last_changed).getTime()
      : windowEnd;

    if (active) {
      if (runStart === null) runStart = tStart;
      // If this is the last record or the next record ends the run, close it
      if (i + 1 === ovStates.length || !isActive(ovStates[i + 1].state)) {
        let xMin = toX(runStart);
        let xMax = toX(tEnd);
        if (xMax - xMin < minWidth) {
          // Centre-expand to minWidth so short pulses are always visible
          const mid = (xMin + xMax) / 2;
          xMin = mid - minWidth / 2;
          xMax = mid + minWidth / 2;
        }
        annotations[`r${idx++}`] = boxAnnotation(xMin, xMax, pal);
        runStart = null;
      }
    }
  }

  return annotations;
}

function boxAnnotation(xMin, xMax, pal) {
  return {
    type: "box",
    xScaleID: "x",
    yScaleID: "y",
    xMin,
    xMax,
    yMin: undefined,  // undefined = full axis extent
    yMax: undefined,
    backgroundColor: pal.overlayResolved,
    borderColor: pal.border,
    borderWidth: 1,
    borderDash: [4, 3],
    drawTime: "beforeDatasetsDraw",
  };
}

// ---------------------------------------------------------------------------
// Determine "auto" overlay colour from entity domain / device_class
// ---------------------------------------------------------------------------
// Domains whose states are on/off (or open/closed) rather than numeric
const ON_OFF_DOMAINS = new Set([
  "binary_sensor", "switch", "valve", "input_boolean",
  "automation", "script", "cover", "lock", "fan",
]);

function isOnOffDomain(entityId) {
  return ON_OFF_DOMAINS.has(entityId.split(".")[0]);
}

function autoColor(overlayEntityId = "", deviceClass = "") {
  const domain = overlayEntityId.split(".")[0];
  const name   = overlayEntityId.split(".")[1] || "";
  const dc     = deviceClass || name;

  // Valve / irrigation / water
  if (domain === "valve")                               return "teal";
  if (/moisture|irrigation|water|valve/.test(dc))       return "teal";

  // Heating / temperature
  if (/heat|temp|boiler|furnace/.test(dc))              return "amber";

  // Hazard
  if (/smoke|gas|co2?|danger|alarm/.test(dc))           return "red";

  // Presence / motion
  if (/motion|occupancy|presence|person/.test(dc))      return "purple";

  // Switch / plug / power
  if (domain === "switch" && /pump|motor|fan/.test(dc)) return "blue";

  return "teal";
}

// ---------------------------------------------------------------------------
// Card element
// ---------------------------------------------------------------------------
class OverlayGraphCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._chart = null;
    this._config = null;
    this._hass = null;
    this._updating = false;
    this._lastFetch = 0;
    this._POINTS = 96;
  }

  static getConfigElement() {
    return document.createElement("overlay-graph-card-editor");
  }

  static getStubConfig(hass) {
    const ids = hass ? Object.keys(hass.states) : [];
    const sensor = ids.find((id) =>
      id.startsWith("sensor.") &&
      !isNaN(parseFloat(hass.states[id].state)) &&
      hass.states[id].attributes.unit_of_measurement
    ) || "sensor.example";
    const overlay = ids.find((id) => id.startsWith("binary_sensor.")) || "binary_sensor.example";
    return {
      entity: sensor,
      hours_to_show: 24,
      graph: "line",
      overlay: [{ entity: overlay, color: "auto" }],
    };
  }

  setConfig(config) {
    if (!config.entity) throw new Error("overlay-graph-card: 'entity' is required.");

    // Normalise overlay: single object or array → always an array internally
    const rawOverlays = config.overlay
      ? (Array.isArray(config.overlay) ? config.overlay : [config.overlay])
      : [];
    // Overlays without an entity (e.g. just added in the editor) are skipped
    const overlays = rawOverlays
      .filter((ov) => ov && ov.entity)
      .map((ov) => ({ ...OVERLAY_DEFAULTS, ...ov }));

    this._config = {
      name: null,
      icon: null,
      color: "teal",
      hours_to_show: 24,
      graph: "line",
      smoothing: true,
      unit: null,
      ...ACTION_DEFAULTS,
      ...config,
      overlays,
      show: { ...SHOW_DEFAULTS, ...(config.show || {}) },
    };
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
    this._render();
    this._lastFetch = 0;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.isConnected) return;
    const now = Date.now();
    // throttle: refresh at most every 30 s
    if (!this._lastFetch || now - this._lastFetch > 30000) {
      this._lastFetch = now;
      this._updateData();
    }
  }

  connectedCallback() {
    // Re-draw after being re-attached (dashboard navigation, edit mode)
    if (this._hass && this._config && !this._chart) {
      this._lastFetch = 0;
      this.hass = this._hass;
    }
  }

  disconnectedCallback() {
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
  }

  // ---- DOM skeleton -------------------------------------------------------
  _render() {
    const c = this._config;
    const shadow = this.shadowRoot;
    shadow.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.08));
          padding: 1rem 1.25rem 0.75rem;
          font-family: var(--primary-font-family, 'Roboto', sans-serif);
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 0.5rem;
          gap: 8px;
        }
        .title-block { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .icon { color: var(--state-icon-color, #44739e); --mdc-icon-size: 20px; flex-shrink: 0; }
        .name {
          font-size: 14px;
          font-weight: 500;
          color: var(--primary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .entity-id { font-size: 11px; color: var(--secondary-text-color); margin-top: 1px; }
        .value-block { text-align: right; flex-shrink: 0; }
        .current-value { font-size: 22px; font-weight: 500; color: var(--primary-text-color); line-height: 1; }
        .unit { font-size: 13px; color: var(--secondary-text-color); font-weight: 400; }
        .state-age { font-size: 11px; color: var(--secondary-text-color); margin-top: 2px; }
        .chart-wrap { position: relative; width: 100%; height: 160px; margin: 0.5rem 0; }
        .extremes {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: var(--secondary-text-color);
          padding: 0 2px;
          margin-top: -6px;
          margin-bottom: 4px;
        }
        .legend {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          padding: 6px 0 2px;
          border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
          margin-top: 4px;
        }
        .legend-item { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--secondary-text-color); }
        .legend-swatch { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
        .loading { font-size: 13px; color: var(--secondary-text-color); padding: 2rem 0; text-align: center; }
        .error { font-size: 12px; color: var(--error-color, #db4437); padding: 0.5rem 0; }
      </style>
      <ha-card class="card">
        <div class="header">
          <div class="title-block">
            ${c.show.icon ? `<ha-icon class="icon" id="card-icon"></ha-icon>` : ""}
            <div>
              ${c.show.name ? `<div class="name" id="card-name">${escapeHtml(c.name || c.secondary_info || c.entity)}</div>` : ""}
              ${(() => {
                // secondary_info: explicit label always shown if set
                if (c.secondary_info) return `<div class="entity-id">${escapeHtml(c.secondary_info)}</div>`;
                // entity_id: hidden when statistics is on (would just be noise next to Mean/Min/Max)
                if (c.show.entity_id !== false && !c.show.statistics) return `<div class="entity-id" id="card-entity-id">${escapeHtml(c.entity)}</div>`;
                return "";
              })()}
            </div>
          </div>
          ${c.show.current_value ? `
          <div class="value-block">
            <div><span class="current-value" id="card-value">—</span><span class="unit" id="card-unit"> ${escapeHtml(c.unit || "")}</span></div>
            <div class="state-age" id="card-age"></div>
          </div>` : ""}
        </div>
        <div class="chart-wrap"><canvas id="ogc" role="img" aria-label="Sensor history graph"></canvas></div>
        <div class="error" id="card-error" hidden></div>
        ${c.show.extremes ? `<div class="extremes"><span id="extreme-min"></span><span id="extreme-max"></span></div>` : ""}
        ${c.show.legend ? `
        <div class="legend">
          <div class="legend-item">
            <div class="legend-swatch" id="primary-swatch"></div>
            <span id="primary-legend-label">${c.show.statistics ? "Mean" : escapeHtml(c.name || c.secondary_info || c.entity)}</span>
          </div>
          ${c.show.statistics ? `
          <div class="legend-item">
            <div class="legend-swatch" id="stats-band-swatch" style="opacity:0.55"></div>
            <span>Min / Max range</span>
          </div>` : ""}
          ${c.overlays.map((ov, i) => `
          <div class="legend-item">
            <div class="legend-swatch overlay-swatch" id="overlay-swatch-${i}" style="border: 1px solid #aaa"></div>
            <span>${escapeHtml(ov.label || "Active")}${ov.invert ? " (off)" : ""}</span>
          </div>`).join("")}
        </div>` : ""}
      </ha-card>
    `;

    // Tap / hold action wiring
    const card = this.shadowRoot.querySelector(".card");
    if (card) {
      let pressTimer = null;
      const hasTap = c.tap_action && c.tap_action.action !== "none";
      const hasHold = c.hold_action && c.hold_action.action !== "none";
      if (hasTap || hasHold) card.style.cursor = "pointer";
      card.addEventListener("pointerdown", () => {
        pressTimer = setTimeout(() => {
          pressTimer = null;
          this._handleAction("hold");
        }, 500);
      });
      card.addEventListener("pointerup", () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
          this._handleAction("tap");
        }
      });
      card.addEventListener("pointerleave", () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      });
    }
  }

  // ---- Action handling ----------------------------------------------------
  // Delegates to Home Assistant's built-in action handler, which supports
  // more-info, toggle, navigate, url, perform-action (and legacy call-service),
  // assist, fire-dom-event, confirmation and haptics.
  _handleAction(type) {
    const c = this._config;
    const actionConfig = type === "hold" ? c.hold_action : c.tap_action;
    if (!actionConfig || actionConfig.action === "none") return;
    // A per-action `entity` overrides the card entity (more-info / toggle)
    const config = {
      entity: actionConfig.entity || c.entity,
      tap_action: c.tap_action,
      hold_action: c.hold_action,
    };
    this.dispatchEvent(new CustomEvent("hass-action", {
      detail: { config, action: type },
      bubbles: true,
      composed: true,
    }));
  }

  // ---- Data + chart update ------------------------------------------------
  async _updateData() {
    if (this._updating || !this._hass || !this._config) return;
    this._updating = true;
    try {
      const c = this._config;
      const hass = this._hass;
      const stateObj = hass.states[c.entity];

      // Update header
      if (c.show.name) {
        const nameEl = this.shadowRoot.getElementById("card-name");
        if (nameEl) {
          nameEl.textContent =
            c.name ||
            (stateObj && stateObj.attributes.friendly_name) ||
            c.entity;
        }
      }
      if (c.show.icon) {
        const iconEl = this.shadowRoot.getElementById("card-icon");
        if (iconEl && stateObj) {
          iconEl.icon = c.icon || stateObj.attributes.icon || _domainIcon(c.entity);
        }
      }

      // Current value + unit
      if (c.show.current_value && stateObj) {
        const valEl = this.shadowRoot.getElementById("card-value");
        const unitEl = this.shadowRoot.getElementById("card-unit");
        const ageEl = this.shadowRoot.getElementById("card-age");
        if (valEl) {
          const v = parseFloat(stateObj.state);
          valEl.textContent = isNaN(v) ? stateObj.state : v.toFixed(1);
        }
        if (unitEl) {
          unitEl.textContent =
            " " + (c.unit || stateObj.attributes.unit_of_measurement || "");
        }
        if (ageEl && stateObj.last_changed) {
          ageEl.textContent = _relativeTime(stateObj.last_changed);
        }
      }

      // One shared time window for primary, overlays and labels
      const windowEnd = Date.now();
      const windowStart = windowEnd - c.hours_to_show * 3600 * 1000;
      this._unit = c.unit || (stateObj && stateObj.attributes.unit_of_measurement) || "";

      // Fetch history / statistics for primary
      let primaryData; // { means, mins, maxs } | number[]
      if (c.show.statistics) {
        const statRows = await fetchStatistics(hass, c.entity, windowStart, windowEnd);
        if (statRows) {
          primaryData = resampleStats(statRows, this._POINTS, windowStart, windowEnd);
        } else {
          // No stats recorded – fall back silently to raw history (mean only)
          const raw = await fetchHistory(hass, c.entity, windowStart, windowEnd);
          const pts = resampleToPoints(raw, this._POINTS, windowStart, windowEnd);
          primaryData = { means: pts, mins: pts, maxs: pts };
        }
      } else {
        const raw = await fetchHistory(hass, c.entity, windowStart, windowEnd);
        primaryData = resampleToPoints(raw, this._POINTS, windowStart, windowEnd);
      }

      // Fetch history for all overlays in parallel
      const overlayResults = await Promise.all(
        c.overlays.map(async (ov) => ({
          ov,
          isActive: makeActiveTest(ov),
          states: await fetchHistory(hass, ov.entity, windowStart, windowEnd),
        }))
      );

      const labels = generateLabels(windowStart, windowEnd, this._POINTS, localeOpts(hass));
      await this._drawChart(labels, primaryData, overlayResults, windowStart, windowEnd);
      this._showError(null);
    } catch (e) {
      console.error("overlay-graph-card error:", e);
      this._showError(e && e.message ? e.message : String(e));
    } finally {
      this._updating = false;
    }
  }

  _showError(msg) {
    const el = this.shadowRoot.getElementById("card-error");
    if (!el) return;
    el.textContent = msg ? `overlay-graph-card: ${msg}` : "";
    el.hidden = !msg;
  }

  async _drawChart(labels, primaryData, overlayResults, windowStart, windowEnd) {
    // The card may have been detached or re-rendered while awaiting
    if (!this.isConnected) return;
    const canvas = this.shadowRoot.getElementById("ogc");
    if (!canvas) return;
    if (this._chart && this._chart.canvas !== canvas) {
      this._chart.destroy();
      this._chart = null;
    }
    const c = this._config;
    const unit = this._unit || "";
    const locale = localeOpts(this._hass);

    const graphColor = c.color || "teal";

    // Build per-overlay palettes
    const overlayPalettes = c.overlays.map((ov) => {
      const ovColor = ov.color && ov.color !== "auto"
        ? ov.color
        : (ov.color === "auto" ? autoColor(ov.entity, "") : graphColor);
      return palette(graphColor, ovColor, ov.opacity ?? 0.35);
    });

    // For graph line/fill we only need the graph palette
    const pal = palette(graphColor, graphColor, 0.35);

    // Annotation plugin check

    // Support both raw array and stats object
    const isStats = primaryData && !Array.isArray(primaryData);
    const meanArr = isStats ? primaryData.means : primaryData;
    const minArr  = isStats ? primaryData.mins  : primaryData;
    const maxArr  = isStats ? primaryData.maxs  : primaryData;

    // Extremes
    const validMeans = meanArr.filter((v) => v !== null);
    const validMins  = minArr.filter((v) => v !== null);
    const validMaxs  = maxArr.filter((v) => v !== null);
    const minVal = validMins.length  ? Math.min(...validMins)  : 0;
    const maxVal = validMaxs.length  ? Math.max(...validMaxs)  : 0;
    const meanMin = validMeans.length ? Math.min(...validMeans) : minVal;
    const meanMax = validMeans.length ? Math.max(...validMeans) : maxVal;
    if (c.show.extremes) {
      const minEl = this.shadowRoot.getElementById("extreme-min");
      const maxEl = this.shadowRoot.getElementById("extreme-max");
      if (minEl) minEl.textContent = `min ${minVal.toFixed(1)}`;
      if (maxEl) maxEl.textContent = `max ${maxVal.toFixed(1)}`;
    }

    // Legend swatches
    const ps = this.shadowRoot.getElementById("primary-swatch");
    if (ps) ps.style.background = pal.line;
    const sbs = this.shadowRoot.getElementById("stats-band-swatch");
    if (sbs) {
      const gp = PALETTES[graphColor] || PALETTES.teal;
      sbs.style.background = gp.overlay.replace("{A}", "0.55");
    }
    c.overlays.forEach((ov, i) => {
      const os = this.shadowRoot.getElementById(`overlay-swatch-${i}`);
      if (os) {
        const ovPal = overlayPalettes[i];
        os.style.background = ovPal.overlayResolved;
        os.style.borderColor = ovPal.border;
      }
    });

    // Build annotations from all overlays, merged into one object
    const annotations = {};
    overlayResults.forEach(({ states, isActive }, oi) => {
      if (!states || !states.length) return;
      const ovPal = overlayPalettes[oi];
      const ovAnnotations = buildAnnotationsFromStates(
        states, windowStart, windowEnd, ovPal, this._POINTS, isActive
      );
      // Prefix keys to avoid collisions between overlays
      Object.entries(ovAnnotations).forEach(([k, v]) => {
        annotations[`ov${oi}_${k}`] = v;
      });
    });

    // Dark mode: follow HA's active theme, fall back to the OS setting
    const themes = this._hass && this._hass.themes;
    const isDark = themes && typeof themes.darkMode === "boolean"
      ? themes.darkMode
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)";
    const tickColor = isDark ? "rgba(255,255,255,0.38)" : "rgba(0,0,0,0.38)";

    const yPad = (maxVal - minVal) * 0.1 || 1;
    const yMin = Math.floor(minVal - yPad);
    const yMax = Math.ceil(maxVal + yPad);

    const isBar = c.graph === "bar";
    // smoothing: false/0 = raw data + straight lines
    //            true    = Gaussian pre-smooth at strength 0.4 + monotone curves
    //            0–1     = smoothing strength (0 = none, 1 = very smooth)
    const smoothStrength = smoothingStrength(c.smoothing);

    // Pre-smooth the data arrays – this is where the visual difference comes from
    const sMean = smoothArray(meanArr, smoothStrength);
    const sMin  = smoothArray(minArr,  smoothStrength);
    const sMax  = smoothArray(maxArr,  smoothStrength);

    // All line charts use monotone curves; straight lines when smoothing is off
    const cubicMode = smoothStrength > 0 ? "monotone" : "default";

    let datasets;
    if (isStats && (minArr !== meanArr)) {
      // Stats mode: min boundary (hidden) → fill to max → mean line on top
      const statsOpacity = c.show.statistics_opacity ?? 0.18;
      const gp = PALETTES[graphColor] || PALETTES.teal;
      const bandFill = gp.overlay.replace("{A}", statsOpacity);
      datasets = [
        {
          label: "_min",
          data: sMin,
          borderColor: "transparent",
          backgroundColor: "transparent",
          fill: false,
          pointRadius: 0,
          cubicInterpolationMode: cubicMode,
          spanGaps: true,
        },
        {
          label: "_max",
          data: sMax,
          borderColor: "transparent",
          backgroundColor: bandFill,
          fill: "-1",
          pointRadius: 0,
          cubicInterpolationMode: cubicMode,
          spanGaps: true,
        },
        {
          label: c.name || c.secondary_info || c.entity,
          data: sMean,
          borderColor: pal.line,
          backgroundColor: "transparent",
          fill: false,
          cubicInterpolationMode: cubicMode,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
          spanGaps: true,
        },
      ];
    } else {
      datasets = [
        {
          label: c.name || c.secondary_info || c.entity,
          data: sMean,
          borderColor: pal.line,
          backgroundColor: isBar
            ? (() => {
                const first = overlayResults[0];
                if (!first || !first.states || !first.states.length) return pal.fill;
                return meanArr.map((_, i) => {
                  const t = gridTime(i, this._POINTS, windowStart, windowEnd);
                  return activeAt(first.states, first.isActive, t)
                    ? overlayPalettes[0].overlayResolved
                    : pal.fill;
                });
              })()
            : pal.fill,
          fill: !isBar,
          cubicInterpolationMode: cubicMode,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: isBar ? 1 : 2,
          borderRadius: isBar ? 2 : undefined,
          spanGaps: true,
        },
      ];
    }

    const chartConfig = {
      type: isBar ? "bar" : "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          annotation: { annotations },
          tooltip: {
            filter: (item) => !item.dataset.label.startsWith("_"),
            callbacks: {
              title: (items) => items[0].label,
              label: isStats
                ? (item) => {
                    const i = item.dataIndex;
                    const fmt = (v) => v != null ? v.toFixed(1) + unit : "—";
                    return [
                      `Mean: ${fmt(meanArr[i])}`,
                      `Min:  ${fmt(minArr[i])}`,
                      `Max:  ${fmt(maxArr[i])}`,
                    ];
                  }
                : (item) => `${item.formattedValue}${unit}`,
              afterBody: overlayResults.length
                ? (items) => {
                    const i = items[0].dataIndex;
                    const t = gridTime(i, this._POINTS, windowStart, windowEnd);
                    return overlayResults.flatMap(({ ov, states, isActive }) => {
                      if (!states || !states.length) return [];
                      return activeAt(states, isActive, t) ? [`${ov.label || "Active"}: ON`] : [];
                    });
                  }
                : undefined,
            },
          },
        },
        scales: {
          x: {
            // Replace the per-point category ticks with ticks at round
            // clock times (e.g. every 15 min, hourly, 6-hourly, midnight).
            afterBuildTicks: (scale) => {
              const maxTicks = Math.max(2, Math.floor((scale.width || scale.maxWidth || 300) / 60));
              this._xTicks = buildTimeTicks(windowStart, windowEnd, this._POINTS, maxTicks, locale);
              scale.ticks = this._xTicks.map((t) => ({ value: t.pos }));
            },
            ticks: {
              color: tickColor,
              font: { size: 10 },
              autoSkip: false,
              maxRotation: 0,
              callback: (_v, i) => (this._xTicks && this._xTicks[i] ? this._xTicks[i].label : ""),
            },
            grid: { color: gridColor },
          },
          y: {
            min: yMin,
            max: yMax,
            ticks: {
              color: tickColor,
              font: { size: 10 },
              callback: (v) => v + unit,
            },
            grid: { color: gridColor },
          },
        },
      },
    };

    if (this._chart) {
      this._chart.data = chartConfig.data;
      this._chart.options = chartConfig.options;
      this._chart.update("none");
    } else {
      this._chart = new Chart(canvas, chartConfig);
    }
  }

  // ---- Lovelace helpers ---------------------------------------------------
  getCardSize() { return 4; }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function _domainIcon(entityId) {
  const domain = entityId.split(".")[0];
  const map = {
    sensor: "mdi:eye",
    binary_sensor: "mdi:radiobox-marked",
    switch: "mdi:toggle-switch",
    input_boolean: "mdi:toggle-switch-outline",
    climate: "mdi:thermostat",
    light: "mdi:lightbulb",
    cover: "mdi:window-shutter",
    media_player: "mdi:cast",
    camera: "mdi:camera",
    person: "mdi:account",
  };
  return map[domain] || "mdi:chart-line";
}

function _relativeTime(isoString) {
  const diff = (Date.now() - new Date(isoString).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------
// Guard against double registration (e.g. resource loaded from two URLs)
if (!customElements.get("overlay-graph-card")) {
  customElements.define("overlay-graph-card", OverlayGraphCard);
}
if (!customElements.get("overlay-graph-card-editor")) {
  customElements.define("overlay-graph-card-editor", OverlayGraphCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "overlay-graph-card")) window.customCards.push({
  type: "overlay-graph-card",
  name: "Overlay Graph Card",
  description:
    "Plot a sensor with background shading from a secondary binary or numeric sensor (e.g. irrigation valve, heater, motion).",
  preview: true,
  documentationURL: "https://github.com/hdcoffeeboy/ha-overlay-graph-card",
});

console.info(
  `%c OVERLAY-GRAPH-CARD %c v${CARD_VERSION} `,
  "background:#1D9E75; color:#fff; font-weight:700; padding:2px 6px; border-radius:3px 0 0 3px;",
  "background:#222; color:#1D9E75; font-weight:700; padding:2px 6px; border-radius:0 3px 3px 0;"
);
