// Shared between the card and its editor

export const PALETTE_NAMES = ["teal", "blue", "amber", "coral", "purple", "green", "red"];

export const SHOW_DEFAULTS = {
  name: true,
  icon: true,
  entity_id: true,
  current_value: true,
  legend: true,
  extremes: false,
  statistics: false,
  statistics_opacity: 0.18,
};

export const OVERLAY_DEFAULTS = {
  color: null,          // null = inherit graph colour
  opacity: 0.35,
  threshold: null,
  active_state: null,
  label: "Active",
  invert: false,
};

export const ACTION_DEFAULTS = {
  tap_action: { action: "more-info" },
  hold_action: { action: "none" },
};

// smoothing: false/0 = off, true = 0.2, number 0–1 = strength
export const DEFAULT_SMOOTHING = 0.2;

export function smoothingStrength(value) {
  if (typeof value === "number") return Math.min(1, Math.max(0, value));
  if (value === undefined) return DEFAULT_SMOOTHING;
  return value ? DEFAULT_SMOOTHING : 0;
}
