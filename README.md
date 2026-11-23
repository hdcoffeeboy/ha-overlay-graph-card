# Overlay Graph Card

Home Assistant Lovelace card that plots a sensor's history and shades background regions when one or more other entities are active (valve open, compressor running, door open, etc.).

## Installation (manual)

1. Copy `overlay-graph-card.js` to `<config>/www/`.
2. Add a dashboard resource: URL `/local/overlay-graph-card.js`, type **JavaScript module**.

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
