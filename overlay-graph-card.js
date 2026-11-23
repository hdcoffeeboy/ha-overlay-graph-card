/**
 * overlay-graph-card
 * A Home Assistant Lovelace card that plots a primary sensor and shades
 * background regions based on a secondary binary or numeric sensor.
 *
 * Installation: copy to <config>/www/overlay-graph-card.js
 * Register in configuration.yaml (or via UI Resources):
 *   lovelace:
 *     resources:
 *       - url: /local/overlay-graph-card.js
 *         type: module
 *
 * Example config:
 *   type: custom:overlay-graph-card
 *   entity: sensor.garden_moisture
 *   name: Garden soil moisture
 *   unit: "%"
 *   hours_to_show: 24
 *   overlay:
 *     entity: binary_sensor.irrigation_valve
 *     color: teal        # teal | blue | amber | coral | purple | green | red | auto
 *     label: Irrigation active
 *     opacity: 0.22      # optional, default 0.22
 *     threshold: 0.1     # numeric sensors only – treat as active above this value
 *   color: teal             # graph line/fill colour (teal | blue | amber | coral | purple | green | red)
 *   graph: line            # line | bar
 *   smoothing: true
 *   show:
 *     statistics: false    # show min/max band + mean line
 *     statistics_opacity: 0.18  # opacity of the min/max band (0–1)
 *     extremes: false
 *   overlay:
 *     entity: binary_sensor.irrigation_valve
 *     color: amber         # defaults to graph color if omitted
 *     opacity: 0.35
 *     label: Irrigation active
 *     threshold: 0.1       # numeric sensors only
 */

const CARD_VERSION = "1.0.0";

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
// Chart.js CDN – loaded once
// ---------------------------------------------------------------------------
const CHARTJS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
const ANNOTATION_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js";

let chartJsReady = null;

function loadChartJs() {
  if (chartJsReady) return chartJsReady;
  chartJsReady = new Promise((resolve) => {
    if (window.Chart && window.Chart.Annotation) { resolve(); return; }
    const s1 = document.createElement("script");
    s1.src = CHARTJS_URL;
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = ANNOTATION_URL;
      s2.onload = resolve;
      document.head.appendChild(s2);
    };
    document.head.appendChild(s1);
  });
  return chartJsReady;
}

// ---------------------------------------------------------------------------
// History fetching helpers
// ---------------------------------------------------------------------------
async function fetchHistory(hass, entityId, hoursToShow) {
  const end = new Date();
  const start = new Date(end - hoursToShow * 3600 * 1000);
  const url =
    `history/period/${start.toISOString()}?filter_entity_id=${entityId}` +
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
async function fetchStatistics(hass, entityId, hoursToShow) {
  const end = new Date();
  const start = new Date(end - hoursToShow * 3600 * 1000);
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

function resampleToPoints(states, count, isNumeric) {
  if (!states.length) return Array(count).fill(null);
  const first = new Date(states[0].last_changed).getTime();
  const last = new Date(states[states.length - 1].last_changed).getTime();
  const step = (last - first) / (count - 1) || 1;
  const out = [];
  let si = 0;
  for (let i = 0; i < count; i++) {
    const t = first + i * step;
    while (si < states.length - 1 && new Date(states[si + 1].last_changed).getTime() <= t) si++;
    const v = states[si].state;
    if (isNumeric) {
      out.push(isNaN(parseFloat(v)) ? null : parseFloat(v));
    } else {
      // on/off: binary_sensor, switch, input_boolean, automation
      // open/closed: valve, cover
      // locked/unlocked: lock
      // active/idle/standby: various
      const TRUTHY = new Set(["on","true","1","open","unlocked","active","running","heating","cooling","fan_only"]);
      out.push(TRUTHY.has(v) ? 1 : 0);
    }
  }
  return out;
}

function resampleStats(rows, count, hoursToShow) {
  // rows: [{t, mean, min, max}] – may be sparse; interpolate onto uniform grid
  const end = Date.now();
  const start = end - hoursToShow * 3600 * 1000;
  const means = [], mins = [], maxs = [];
  let ri = 0;
  for (let i = 0; i < count; i++) {
    const t = start + (i / (count - 1)) * (end - start);
    while (ri < rows.length - 1 && rows[ri + 1].t <= t) ri++;
    means.push(rows[ri].mean);
    mins.push(rows[ri].min);
    maxs.push(rows[ri].max);
  }
  return { means, mins, maxs };
}

function generateLabels(hoursToShow, count) {
  const end = Date.now();
  const start = end - hoursToShow * 3600 * 1000;
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(start + (i / (count - 1)) * (end - start));
    return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  });
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
function buildAnnotationsFromStates(ovStates, windowStart, windowEnd, pal, points, threshold, invert = false, activeState = null) {
  if (!ovStates || !ovStates.length) return {};
  const span = windowEnd - windowStart || 1;
  const MIN_FRAC = 0.02;
  const minWidth = MIN_FRAC * points;

  const TRUTHY = new Set(["on","true","1","open","unlocked","active","running","heating","cooling","fan_only"]);
  // active_state: string or array of strings that count as active
  const activeStates = activeState
    ? new Set(Array.isArray(activeState) ? activeState : [activeState])
    : null;

  function isActive(state) {
    let result;
    if (activeStates) {
      result = activeStates.has(state);
    } else if (threshold != null) {
      result = !isNaN(parseFloat(state)) && parseFloat(state) > threshold;
    } else {
      result = TRUTHY.has(state);
    }
    return invert ? !result : result;
  }

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

  static getStubConfig() {
    return {
      entity: "sensor.example",
      hours_to_show: 24,
      graph: "line",
      overlay: { entity: "valve.example", color: "auto" },
    };
  }

  setConfig(config) {
    if (!config.entity) throw new Error("overlay-graph-card: 'entity' is required.");

    // Normalise overlay: single object or array → always an array internally
    const rawOverlays = config.overlay
      ? (Array.isArray(config.overlay) ? config.overlay : [config.overlay])
      : [];
    const overlays = rawOverlays.map((ov) => ({
      color: null,
      opacity: 0.35,
      threshold: null,
      active_state: null,
      label: "Active",
      invert: false,
      ...ov,
    }));

    this._config = {
      name: null,
      icon: null,
      color: "teal",
      hours_to_show: 24,
      graph: "line",
      smoothing: true,
      unit: null,
      tap_action: { action: "more-info" },
      hold_action: { action: "none" },
      ...config,
      overlays,
      show: { name: true, icon: true, entity_id: true, current_value: true, legend: true, extremes: false, statistics: false, statistics_opacity: 0.18, ...(config.show || {}) },
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
    const now = Date.now();
    // throttle: refresh at most every 30 s
    if (!this._lastFetch || now - this._lastFetch > 30000) {
      this._lastFetch = now;
      this._updateData();
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
              ${c.show.name ? `<div class="name" id="card-name">${c.name || c.secondary_info || c.entity}</div>` : ""}
              ${(() => {
                // secondary_info: explicit label always shown if set
                if (c.secondary_info) return `<div class="entity-id">${c.secondary_info}</div>`;
                // entity_id: hidden when statistics is on (would just be noise next to Mean/Min/Max)
                if (c.show.entity_id !== false && !c.show.statistics) return `<div class="entity-id" id="card-entity-id">${c.entity}</div>`;
                return "";
              })()}
            </div>
          </div>
          ${c.show.current_value ? `
          <div class="value-block">
            <div><span class="current-value" id="card-value">—</span><span class="unit" id="card-unit"> ${c.unit || ""}</span></div>
            <div class="state-age" id="card-age"></div>
          </div>` : ""}
        </div>
        <div class="chart-wrap"><canvas id="ogc" role="img" aria-label="Sensor history graph"></canvas></div>
        ${c.show.extremes ? `<div class="extremes"><span id="extreme-min"></span><span id="extreme-max"></span></div>` : ""}
        ${c.show.legend ? `
        <div class="legend">
          <div class="legend-item">
            <div class="legend-swatch" id="primary-swatch"></div>
            <span id="primary-legend-label">${c.show.statistics ? "Mean" : (c.name || c.secondary_info || c.entity)}</span>
          </div>
          ${c.show.statistics ? `
          <div class="legend-item">
            <div class="legend-swatch" id="stats-band-swatch" style="opacity:0.55"></div>
            <span>Min / Max range</span>
          </div>` : ""}
          ${c.overlays.map((ov, i) => `
          <div class="legend-item">
            <div class="legend-swatch overlay-swatch" id="overlay-swatch-${i}" style="border: 1px solid #aaa"></div>
            <span>${ov.label || "Active"}${ov.invert ? " (off)" : ""}</span>
          </div>`).join("")}
        </div>` : ""}
      </ha-card>
    `;

    // Tap / hold action wiring
    const card = this.shadowRoot.querySelector(".card");
    if (card) {
      let pressTimer = null;
      card.style.cursor = "pointer";
      card.addEventListener("pointerdown", () => {
        pressTimer = setTimeout(() => {
          pressTimer = null;
          this._handleAction(this._config.hold_action);
        }, 500);
      });
      card.addEventListener("pointerup", () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
          this._handleAction(this._config.tap_action);
        }
      });
      card.addEventListener("pointerleave", () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      });
    }
  }

  // ---- Action handling ----------------------------------------------------
  _handleAction(actionConfig) {
    if (!actionConfig || !this._hass) return;
    const { action, navigation_path, service, service_data, entity } = actionConfig;
    const targetEntity = entity || this._config.entity;
    switch (action) {
      case "more-info":
        this._hass.callService && this.dispatchEvent(
          new CustomEvent("hass-more-info", { detail: { entityId: targetEntity }, bubbles: true, composed: true })
        );
        break;
      case "navigate":
        if (navigation_path) history.pushState(null, "", navigation_path);
        break;
      case "toggle":
        this._hass.callService("homeassistant", "toggle", { entity_id: targetEntity });
        break;
      case "call-service": {
        if (!service) break;
        const [domain, svc] = service.split(".");
        this._hass.callService(domain, svc, service_data || {});
        break;
      }
      case "none":
      default:
        break;
    }
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
          iconEl.icon = stateObj.attributes.icon || _domainIcon(c.entity);
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

      // Fetch history / statistics for primary
      let primaryData; // { means, mins, maxs } | number[]
      if (c.show.statistics) {
        const statRows = await fetchStatistics(hass, c.entity, c.hours_to_show);
        if (statRows) {
          primaryData = resampleStats(statRows, this._POINTS, c.hours_to_show);
        } else {
          // No stats recorded – fall back silently to raw history (mean only)
          const raw = await fetchHistory(hass, c.entity, c.hours_to_show);
          const pts = resampleToPoints(raw, this._POINTS, true);
          primaryData = { means: pts, mins: pts, maxs: pts };
        }
      } else {
        const raw = await fetchHistory(hass, c.entity, c.hours_to_show);
        primaryData = resampleToPoints(raw, this._POINTS, true);
      }

      // Fetch history for all overlays in parallel
      const overlayResults = await Promise.all(
        c.overlays.map(async (ov) => ({
          ov,
          states: await fetchHistory(hass, ov.entity, c.hours_to_show),
        }))
      );

      const windowEnd = Date.now();
      const windowStart = windowEnd - c.hours_to_show * 3600 * 1000;
      const labels = generateLabels(c.hours_to_show, this._POINTS);
      this._drawChart(labels, primaryData, overlayResults, windowStart, windowEnd);
    } catch (e) {
      console.error("overlay-graph-card error:", e);
    } finally {
      this._updating = false;
    }
  }

  async _drawChart(labels, primaryData, overlayResults, windowStart, windowEnd) {
    await loadChartJs();
    const canvas = this.shadowRoot.getElementById("ogc");
    if (!canvas) return;
    const c = this._config;

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
    if (!window.Chart) return;

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
    overlayResults.forEach(({ ov, states }, oi) => {
      if (!states || !states.length) return;
      const ovPal = overlayPalettes[oi];
      const ovAnnotations = buildAnnotationsFromStates(
        states, windowStart, windowEnd, ovPal, this._POINTS, ov.threshold ?? null, ov.invert ?? false, ov.active_state ?? null
      );
      // Prefix keys to avoid collisions between overlays
      Object.entries(ovAnnotations).forEach(([k, v]) => {
        annotations[`ov${oi}_${k}`] = v;
      });
    });

    // Dark mode detect (HA uses prefers-color-scheme)
    const isDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)";
    const tickColor = isDark ? "rgba(255,255,255,0.38)" : "rgba(0,0,0,0.38)";

    const yPad = (maxVal - minVal) * 0.1 || 1;
    const yMin = Math.floor(minVal - yPad);
    const yMax = Math.ceil(maxVal + yPad);

    const isBar = c.graph === "bar";
    // smoothing: false/0 = raw data + straight lines
    //            true    = Gaussian pre-smooth at strength 0.4 + monotone curves
    //            0–1     = smoothing strength (0 = none, 1 = very smooth)
    const smoothStrength = typeof c.smoothing === "number"
      ? Math.min(1, Math.max(0, c.smoothing))
      : (c.smoothing ? 0.2 : 0);

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
                const TRUTHY = new Set(["on","true","1","open","unlocked","active","running","heating","cooling","fan_only"]);
                return meanArr.map((_, i) => {
                  const t = windowStart + (i / (this._POINTS - 1)) * (windowEnd - windowStart);
                  let active = false;
                  for (let s = 0; s < first.states.length; s++) {
                    if (new Date(first.states[s].last_changed).getTime() <= t) {
                      active = first.ov.threshold != null
                        ? parseFloat(first.states[s].state) > first.ov.threshold
                        : TRUTHY.has(first.states[s].state);
                    }
                  }
                  if (first.ov.invert) active = !active;
                  return active ? overlayPalettes[0].overlayResolved : pal.fill;
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
                    const unit = c.unit || "";
                    const fmt = (v) => v != null ? v.toFixed(1) + unit : "—";
                    return [
                      `Mean: ${fmt(meanArr[i])}`,
                      `Min:  ${fmt(minArr[i])}`,
                      `Max:  ${fmt(maxArr[i])}`,
                    ];
                  }
                : (item) => `${item.formattedValue}${c.unit || ""}`,
              afterBody: overlayResults.length
                ? (items) => {
                    const i = items[0].dataIndex;
                    const t = windowStart + (i / (this._POINTS - 1)) * (windowEnd - windowStart);
                    const TRUTHY = new Set(["on","true","1","open","unlocked","active","running","heating","cooling","fan_only"]);
                    return overlayResults.flatMap(({ ov, states }) => {
                      if (!states || !states.length) return [];
                      const activeStates = ov.active_state
                        ? new Set(Array.isArray(ov.active_state) ? ov.active_state : [ov.active_state])
                        : null;
                      const TRUTHY = new Set(["on","true","1","open","unlocked","active","running","heating","cooling","fan_only"]);
                      let active = false;
                      for (let s = 0; s < states.length; s++) {
                        if (new Date(states[s].last_changed).getTime() <= t) {
                          let result;
                          if (activeStates) {
                            result = activeStates.has(states[s].state);
                          } else if (ov.threshold != null) {
                            result = parseFloat(states[s].state) > ov.threshold;
                          } else {
                            result = TRUTHY.has(states[s].state);
                          }
                          active = ov.invert ? !result : result;
                        }
                      }
                      return active ? [`${ov.label || "Active"}: ON`] : [];
                    });
                  }
                : undefined,
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: tickColor,
              font: { size: 10 },
              maxTicksLimit: 8,
              maxRotation: 0,
            },
            grid: { color: gridColor },
          },
          y: {
            min: yMin,
            max: yMax,
            ticks: {
              color: tickColor,
              font: { size: 10 },
              callback: (v) =>
                v + (c.unit || ""),
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
      this._chart = new window.Chart(canvas, chartConfig);
    }
  }

  // ---- Lovelace helpers ---------------------------------------------------
  getCardSize() { return 4; }
}

// ---------------------------------------------------------------------------
// Minimal editor element (shows raw YAML hint)
// ---------------------------------------------------------------------------
class OverlayGraphCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; }
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 1rem; }
        pre { font-size: 12px; background: #f5f5f5; padding: 12px; border-radius: 8px; overflow: auto; }
      </style>
      <p style="font-size:13px; color: #555; margin: 0 0 8px;">
        Edit via the YAML editor. Example config:
      </p>
      <pre>
type: custom:overlay-graph-card
entity: sensor.coolroom_temperature
name: Cool Room
secondary_info: "Compressor + door monitoring"  # optional label below name; hides entity ID when set
unit: "°C"
hours_to_show: 24
color: blue
graph: line
smoothing: 0.2

# Single overlay (object form – back-compatible)
# overlay:
#   entity: binary_sensor.coolroom_compressor
#   label: Compressor
#   color: amber
#   opacity: 0.35
#   invert: false      # true = highlight when OFF instead of ON
#   threshold: null    # numeric sensors: active above this value

# Multiple overlays (list form)
overlay:
  - entity: binary_sensor.coolroom_compressor
    label: Compressor running
    color: amber
    opacity: 0.35
    invert: false      # true = highlight when inactive instead
    # threshold: 0.1   # numeric sensors: active above this value
    # active_state: "running"             # single string state
    # active_state: ["heating","cooling"] # or a list of states
  - entity: binary_sensor.coolroom_door
    label: Door open
    color: coral
    opacity: 0.30
    invert: false

# Tap / hold actions
tap_action:
  action: more-info          # more-info | navigate | toggle | call-service | none
hold_action:
  action: call-service
  service: script.start_irrigation
  # service_data:
  #   duration: 300
  # navigation_path: /lovelace/irrigation  (for navigate action)
  # entity: switch.other_entity            (overrides card entity for toggle/more-info)

show:
  name: true
  icon: true
  entity_id: true
  current_value: true
  legend: true
  extremes: false
  statistics: false
  statistics_opacity: 0.18</pre>
    `;
  }
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
customElements.define("overlay-graph-card", OverlayGraphCard);
customElements.define("overlay-graph-card-editor", OverlayGraphCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "overlay-graph-card",
  name: "Overlay Graph Card",
  description:
    "Plot a sensor with background shading from a secondary binary or numeric sensor (e.g. irrigation valve, heater, motion).",
  preview: false,
  documentationURL: "https://github.com/your-repo/overlay-graph-card",
});

console.info(
  `%c OVERLAY-GRAPH-CARD %c v${CARD_VERSION} `,
  "background:#1D9E75; color:#fff; font-weight:700; padding:2px 6px; border-radius:3px 0 0 3px;",
  "background:#222; color:#1D9E75; font-weight:700; padding:2px 6px; border-radius:0 3px 3px 0;"
);
