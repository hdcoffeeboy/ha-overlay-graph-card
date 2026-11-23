# Overlay Graph Card

Home Assistant Lovelace card that plots a sensor's history and shades background regions when one or more other entities are active (valve open, compressor running, door open, etc.).

## Installation (manual)

1. Download `overlay-graph-card.js` from the latest [release](https://github.com/hdcoffeeboy/ha-overlay-graph-card/releases) (or build it, below) and copy it to `<config>/www/`.
2. Add a dashboard resource: URL `/local/overlay-graph-card.js`, type **JavaScript module**.

The card is self-contained (Chart.js is bundled); no internet access is needed at runtime.

## Configuration

Configure the card in the YAML editor. Full example:

```yaml
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
  statistics_opacity: 0.18
```

`tap_action` / `hold_action` use Home Assistant's standard [action configuration](https://www.home-assistant.io/dashboards/actions/) (`more-info`, `toggle`, `navigate`, `url`, `perform-action`, `none`). Legacy `call-service` still works.

## Development

Requires Node.js 20+.

```sh
npm install
npm run build   # → dist/overlay-graph-card.js
npm run watch   # rebuild on change
```

Source is in `src/overlay-graph-card.js`. The version shown in the browser console comes from `package.json`.
