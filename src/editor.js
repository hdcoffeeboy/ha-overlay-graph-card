// Visual editor for overlay-graph-card.
// Built on Home Assistant's own <ha-form>, so entity pickers, action editors
// and theming match the built-in cards.

import { mdiArrowDown, mdiArrowUp, mdiDelete, mdiPlus } from "@mdi/js";
import {
  PALETTE_NAMES, SHOW_DEFAULTS, OVERLAY_DEFAULTS, ACTION_DEFAULTS, smoothingStrength,
} from "./const.js";

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const colourOptions = PALETTE_NAMES.map((c) => ({ value: c, label: capitalise(c) }));
const isEmpty = (v) => v === undefined || v === null || v === "";
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// "heating, cooling" → ["heating", "cooling"]; single value → string
function parseStates(text) {
  const states = String(text).split(",").map((s) => s.trim()).filter(Boolean);
  if (!states.length) return undefined;
  return states.length === 1 ? states[0] : states;
}

// ---- Schemas ---------------------------------------------------------------

// The schema depends on the data: an entity picker is shown under an action
// only when that action uses an entity (toggle / more-info).
const ENTITY_ACTIONS = ["toggle", "more-info"];

function actionSchema(key, defaultAction, data) {
  const fields = [{ name: key, selector: { ui_action: { default_action: defaultAction } } }];
  const action = (data[key] || {}).action;
  if (ENTITY_ACTIONS.includes(action)) {
    fields.push({ name: `${key}_entity`, selector: { entity: {} } });
  }
  return fields;
}

const mainSchema = (data) => [
  { name: "entity", required: true, selector: { entity: {} } },
  {
    type: "grid", name: "", schema: [
      { name: "name", selector: { text: {} } },
      { name: "icon", selector: { icon: {} }, context: { icon_entity: "entity" } },
      { name: "secondary_info", selector: { text: {} } },
      { name: "unit", selector: { text: {} } },
    ],
  },
  {
    type: "grid", name: "", schema: [
      { name: "hours_to_show", selector: { number: { min: 1, max: 720, mode: "box", unit_of_measurement: "h" } } },
      { name: "graph", selector: { select: { mode: "dropdown", options: [
        { value: "line", label: "Line" }, { value: "bar", label: "Bar" },
      ] } } },
      { name: "color", selector: { select: { mode: "dropdown", options: colourOptions } } },
      { name: "smoothing", selector: { number: { min: 0, max: 1, step: 0.05, mode: "slider" } } },
    ],
  },
  {
    type: "expandable", name: "show", title: "Display", icon: "mdi:eye", schema: [
      {
        type: "grid", name: "", schema: [
          { name: "name", selector: { boolean: {} } },
          { name: "icon", selector: { boolean: {} } },
          { name: "entity_id", selector: { boolean: {} } },
          { name: "current_value", selector: { boolean: {} } },
          { name: "legend", selector: { boolean: {} } },
          { name: "extremes", selector: { boolean: {} } },
          { name: "statistics", selector: { boolean: {} } },
        ],
      },
      { name: "statistics_opacity", selector: { number: { min: 0, max: 1, step: 0.01, mode: "slider" } } },
    ],
  },
  {
    type: "expandable", name: "interactions", flatten: true, title: "Interactions", icon: "mdi:gesture-tap", schema: [
      ...actionSchema("tap_action", "more-info", data),
      ...actionSchema("hold_action", "none", data),
    ],
  },
];

const MAIN_FIELDS = ["entity", "name", "icon", "secondary_info", "unit", "hours_to_show", "graph", "color", "smoothing"];

const OVERLAY_SCHEMA = [
  { name: "entity", required: true, selector: { entity: {} } },
  {
    type: "grid", name: "", schema: [
      { name: "label", selector: { text: {} } },
      { name: "color", selector: { select: { mode: "dropdown", options: [
        { value: "auto", label: "Auto (from entity type)" }, ...colourOptions,
      ] } } },
    ],
  },
  { name: "opacity", selector: { number: { min: 0.05, max: 1, step: 0.05, mode: "slider" } } },
  { name: "invert", selector: { boolean: {} } },
  {
    type: "grid", name: "", schema: [
      { name: "threshold", selector: { number: { mode: "box", step: "any" } } },
      { name: "active_state", selector: { text: {} } },
    ],
  },
];

const OVERLAY_FIELDS = ["entity", "label", "color", "opacity", "invert", "threshold", "active_state"];

const LABELS = {
  entity: "Entity",
  name: "Name",
  icon: "Icon",
  secondary_info: "Subtitle",
  unit: "Unit",
  hours_to_show: "Hours to show",
  graph: "Graph type",
  color: "Colour",
  smoothing: "Smoothing",
  entity_id: "Entity ID",
  current_value: "Current value",
  legend: "Legend",
  extremes: "Min / max values",
  statistics: "Statistics band",
  statistics_opacity: "Statistics band opacity",
  tap_action: "Tap action",
  hold_action: "Hold action",
  tap_action_entity: "Tap action entity",
  hold_action_entity: "Hold action entity",
  label: "Label",
  opacity: "Opacity",
  invert: "Highlight when inactive",
  threshold: "Threshold",
  active_state: "Active states",
};

const HELPERS = {
  entity_id: "Ignored when a Subtitle is set or the Statistics band is on",
  tap_action_entity: "Defaults to the card entity",
  hold_action_entity: "Defaults to the card entity",
  secondary_info: "Shown under the name instead of the entity ID",
  unit: "Defaults to the entity's unit",
  smoothing: "0 = raw data",
  statistics: "Min/max band and mean line from long-term statistics",
  color: "Default: same as the graph colour",
  threshold: "Numeric entities: active when above this value",
  active_state: "States that count as active, comma-separated (e.g. heating, cooling)",
};

// ---- ha-form loading ---------------------------------------------------------

// HA lazy-loads its form elements. Opening a built-in card's editor forces
// them to load if no other editor has done so yet.
async function ensureHaElements() {
  if (customElements.get("ha-form") && customElements.get("ha-expansion-panel")) return;
  try {
    const helpers = await window.loadCardHelpers();
    for (const type of ["tile", "entities"]) {
      const card = await helpers.createCardElement({ type, entity: "sun.sun", entities: [] });
      if (card && card.constructor.getConfigElement) await card.constructor.getConfigElement();
      if (customElements.get("ha-form")) break;
    }
  } catch (e) {
    console.warn("overlay-graph-card: could not preload editor elements", e);
  }
  await Promise.race([
    customElements.whenDefined("ha-form"),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
}

// ---- Editor element ------------------------------------------------------------

export class OverlayGraphCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._built = false;
    this._overlayCount = -1;
    this._expanded = new Set();
    this._activeText = [];   // raw "Active states" text per overlay, kept while typing
    this._ready = ensureHaElements();
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll("ha-form").forEach((f) => { f.hass = hass; });
  }

  setConfig(config) {
    this._config = { ...config };
    this._ready.then(() => this._update());
  }

  // ---- helpers --------------------------------------------------------------
  _overlays() {
    const o = this._config.overlay;
    return o ? (Array.isArray(o) ? o : [o]) : [];
  }

  _fire(config) {
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  _setOverlays(list) {
    const config = { ...this._config };
    if (list.length) config.overlay = list;
    else delete config.overlay;
    this._fire(config);
    this._update();
  }

  _makeForm(schema) {
    const form = document.createElement("ha-form");
    form.schema = schema;
    form.hass = this._hass;
    form.computeLabel = (s) => LABELS[s.name] || s.title || s.name;
    form.computeHelper = (s) => HELPERS[s.name];
    return form;
  }

  // ---- data mapping: config ⇄ form ----------------------------------------
  _mainData() {
    const c = this._config;
    return {
      ...c,
      hours_to_show: c.hours_to_show ?? 24,
      graph: c.graph || "line",
      color: c.color || "teal",
      smoothing: smoothingStrength(c.smoothing),
      show: { ...SHOW_DEFAULTS, ...(c.show || {}) },
      tap_action: c.tap_action || ACTION_DEFAULTS.tap_action,
      hold_action: c.hold_action || ACTION_DEFAULTS.hold_action,
      tap_action_entity: (c.tap_action || {}).entity,
      hold_action_entity: (c.hold_action || {}).entity,
    };
  }

  _mainChanged(value) {
    const old = this._config;
    const n = { ...old };
    for (const k of MAIN_FIELDS) {
      if (isEmpty(value[k])) delete n[k];
      else n[k] = value[k];
    }
    // Keep the original smoothing value (e.g. `true`) unless the slider moved
    if (value.smoothing === smoothingStrength(old.smoothing)) {
      if (old.smoothing === undefined) delete n.smoothing;
      else n.smoothing = old.smoothing;
    }
    if (n.graph === "line" && old.graph === undefined) delete n.graph;
    if (n.hours_to_show === 24 && old.hours_to_show === undefined) delete n.hours_to_show;
    if (n.color === "teal" && old.color === undefined) delete n.color;
    // Only store show options that differ from the defaults
    const show = {};
    for (const [k, v] of Object.entries(value.show || {})) {
      if (!isEmpty(v) && v !== SHOW_DEFAULTS[k]) show[k] = v;
    }
    if (Object.keys(show).length) n.show = show;
    else delete n.show;
    for (const k of ["tap_action", "hold_action"]) {
      let v = value[k];
      if (!isEmpty(v)) {
        // The action editor may drop `entity`; re-apply it from the picker,
        // and only keep it for actions that use an entity.
        v = { ...v };
        const ent = value[`${k}_entity`];
        if (ENTITY_ACTIONS.includes(v.action) && !isEmpty(ent)) v.entity = ent;
        else delete v.entity;
      }
      if (isEmpty(v) || sameJson(v, ACTION_DEFAULTS[k])) delete n[k];
      else n[k] = v;
    }
    this._fire(n);
  }

  _overlayData(ov, index) {
    return {
      ...ov,
      opacity: ov.opacity ?? OVERLAY_DEFAULTS.opacity,
      invert: !!ov.invert,
      active_state: this._activeStateText(ov, index),
    };
  }

  _activeStateText(ov, index) {
    const raw = this._activeText[index];
    if (raw !== undefined && sameJson(parseStates(raw), ov.active_state ?? undefined)) return raw;
    return Array.isArray(ov.active_state) ? ov.active_state.join(", ") : ov.active_state;
  }

  _overlayChanged(index, value) {
    const n = { ...this._overlays()[index] };
    for (const k of OVERLAY_FIELDS) {
      if (isEmpty(value[k])) delete n[k];
      else n[k] = value[k];
    }
    if (n.opacity === OVERLAY_DEFAULTS.opacity) delete n.opacity;
    if (!n.invert) delete n.invert;
    if (typeof n.active_state === "string") {
      this._activeText[index] = n.active_state;
      const states = parseStates(n.active_state);
      if (states === undefined) delete n.active_state;
      else n.active_state = states;
    }
    const list = this._overlays().slice();
    list[index] = n;
    const config = { ...this._config, overlay: list };
    this._fire(config);
    this._updateOverlayHeaders();
  }

  // ---- rendering -------------------------------------------------------------
  _build() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .section-title {
          margin: 24px 0 8px;
          font-size: 16px;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        ha-expansion-panel { margin-bottom: 8px; }
        .overlay-body { padding: 8px 0 0; }
        .overlay-actions { display: flex; justify-content: flex-end; gap: 4px; margin-top: 4px; }
        .add {
          display: inline-flex; align-items: center; gap: 6px;
          margin-top: 4px; padding: 8px 14px;
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 18px;
          background: none;
          color: var(--primary-color);
          font: inherit; font-weight: 500;
          cursor: pointer;
        }
        .add:hover { background: var(--secondary-background-color); }
        .add svg { width: 18px; height: 18px; fill: currentColor; }
        .empty { color: var(--secondary-text-color); font-size: 14px; margin: 0 0 8px; }
      </style>
      <div id="main"></div>
      <div class="section-title">Overlays</div>
      <div id="overlays"></div>
      <button class="add" id="add" type="button">
        <svg viewBox="0 0 24 24"><path d="${mdiPlus}"></path></svg>Add overlay
      </button>
    `;
    this._mainForm = this._makeForm(mainSchema(this._mainData()));
    this._mainForm.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      this._mainChanged(ev.detail.value);
    });
    this.shadowRoot.getElementById("main").appendChild(this._mainForm);
    this.shadowRoot.getElementById("add").addEventListener("click", () => {
      const list = this._overlays().slice();
      list.push({ entity: "", color: "auto" });
      this._expanded.add(list.length - 1);
      this._setOverlays(list);
    });
    this._built = true;
  }

  _update() {
    if (!this._built) this._build();
    const data = this._mainData();
    this._mainForm.hass = this._hass;
    this._mainForm.schema = mainSchema(data);
    this._mainForm.data = data;

    const overlays = this._overlays();
    if (overlays.length !== this._overlayCount) {
      this._buildOverlays(overlays);
    } else {
      this._overlayForms.forEach((f, i) => {
        f.hass = this._hass;
        f.data = this._overlayData(overlays[i], i);
      });
      this._updateOverlayHeaders();
    }
  }

  _overlayHeader(ov, i) {
    const name = ov.entity && this._hass && this._hass.states[ov.entity]
      ? this._hass.states[ov.entity].attributes.friendly_name || ov.entity
      : ov.entity;
    return ov.label || name || `Overlay ${i + 1}`;
  }

  _updateOverlayHeaders() {
    const overlays = this._overlays();
    (this._overlayPanels || []).forEach((p, i) => {
      if (overlays[i]) p.header = this._overlayHeader(overlays[i], i);
    });
  }

  _iconButton(path, label, onClick, disabled = false) {
    const b = document.createElement("ha-icon-button");
    b.path = path;
    b.label = label;
    b.disabled = disabled;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
    return b;
  }

  _buildOverlays(overlays) {
    const host = this.shadowRoot.getElementById("overlays");
    host.innerHTML = "";
    this._overlayForms = [];
    this._overlayPanels = [];
    this._overlayCount = overlays.length;
    this._activeText = [];

    if (!overlays.length) {
      host.innerHTML = `<p class="empty">No overlays. Add one to shade the graph while an entity is active.</p>`;
      return;
    }

    overlays.forEach((ov, i) => {
      const panel = document.createElement("ha-expansion-panel");
      panel.outlined = true;
      panel.header = this._overlayHeader(ov, i);
      panel.expanded = this._expanded.has(i);
      panel.addEventListener("expanded-changed", (ev) => {
        if (ev.detail.expanded) this._expanded.add(i);
        else this._expanded.delete(i);
      });

      const body = document.createElement("div");
      body.className = "overlay-body";
      const form = this._makeForm(OVERLAY_SCHEMA);
      form.data = this._overlayData(ov, i);
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._overlayChanged(i, ev.detail.value);
      });
      body.appendChild(form);

      const actions = document.createElement("div");
      actions.className = "overlay-actions";
      actions.append(
        this._iconButton(mdiArrowUp, "Move up", () => this._move(i, -1), i === 0),
        this._iconButton(mdiArrowDown, "Move down", () => this._move(i, 1), i === overlays.length - 1),
        this._iconButton(mdiDelete, "Remove overlay", () => this._remove(i)),
      );
      body.appendChild(actions);

      panel.appendChild(body);
      host.appendChild(panel);
      this._overlayForms.push(form);
      this._overlayPanels.push(panel);
    });
  }

  _move(i, dir) {
    const list = this._overlays().slice();
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    // Keep expanded state attached to the moved overlays
    const ei = this._expanded.has(i), ej = this._expanded.has(j);
    this._expanded.delete(i); this._expanded.delete(j);
    if (ei) this._expanded.add(j);
    if (ej) this._expanded.add(i);
    this._overlayCount = -1; // force rebuild so buttons/indices refresh
    this._setOverlays(list);
  }

  _remove(i) {
    const list = this._overlays().slice();
    list.splice(i, 1);
    this._expanded = new Set([...this._expanded].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)));
    this._setOverlays(list);
  }
}
