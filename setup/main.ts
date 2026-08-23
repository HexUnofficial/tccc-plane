import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import QRCode from 'qrcode'
import './styles.css'

import { createCircuit } from '../src/circuit'
import { bearingBetween, compassPoint, destination, distanceBetween } from '../src/geo'
import { FLIGHT, FLIGHT_HEADING, INSTALLATION } from '../src/location'

/**
 * Authoring tool for placing the flight circuit on a map.
 *
 * Ported from tccc-ar-test/src/setup/main.js. Two things have to be decided on
 * a map and can't sensibly be typed: the exact stretch of water, and its
 * bearing. A postcode gives you neither.
 *
 * So the two pins are the two *ends of the run* — the aircraft beats back and
 * forth between them. Everything the AR page needs falls out of that pair: the
 * anchor is their midpoint, the heading is the bearing from A to B, and the leg
 * length is the distance between them.
 *
 * The outline drawn on the map is sampled from `../src/circuit`, the same
 * arithmetic `flight-path.ts` flies the aircraft along, not an approximation of
 * it. It deliberately imports `circuit.ts` and not `flight-path.ts`: the latter
 * imports `@8thwall/ecs`, which webpack maps to the `window.ecs` global that
 * only the AR page's runtime script tag provides — on this page that import
 * would resolve to undefined and the module would throw at load.
 *
 * This page is a separate webpack entry (see config/webpack.config.js) and
 * lives outside src/ so the virtual-entry plugin does not sweep it into the AR
 * bundle. Build with EXCLUDE_SETUP=1 to leave it out entirely.
 */

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const input = (id: string) => el<HTMLInputElement>(id)

const params = new URLSearchParams(location.search)
const num = (key: string, fallback: number) => {
  const value = Number.parseFloat(params.get(key) ?? '')
  return Number.isFinite(value) ? value : fallback
}

/*
 * Open on whatever is currently deployed, so the page describes the real
 * installation rather than a set of defaults nobody chose — and let the query
 * string override any of it, so a link this page emitted can be reopened here
 * and carried on from.
 */
const startHeading = num('heading', FLIGHT_HEADING)
const startLength = num('length', FLIGHT.length)
const startCentre = { lat: num('lat', INSTALLATION.lat), lon: num('lon', INSTALLATION.lon) }

/** The two ends of the run. Heading, length and anchor are all derived. */
const state = {
  a: destination(startCentre, (startHeading + 180) % 360, startLength / 2),
  b: destination(startCentre, startHeading, startLength / 2),
  turnRadius: num('turn', FLIGHT.turnRadius),
  altitude: num('alt', FLIGHT.altitude),
  speed: num('speed', FLIGHT.speed),
  /**
   * Length of the whole assembly — aircraft, tow line and banner — in metres.
   *
   * Unlike every other slider this one is *not* emitted in the URL: nothing in
   * this project reads a `size` parameter (the model's scale lives in
   * .expanse.json). It is here to answer "is it going to be a speck?" and to
   * fill in FLIGHT.size in the snippet.
   */
  size: num('size', FLIGHT.size),
  /** Not sent to the AR page either; only used to predict how big it will look. */
  viewer: num('viewer', 200),
}

/**
 * Roughly how tall the aircraft will be on a phone screen.
 *
 * Assumes about 60 degrees of vertical field of view over 850 pixels, which is
 * typical for a portrait phone. Approximate on purpose — the point is to answer
 * "is it going to be a speck?" before walking to the river, not to be exact.
 */
function apparentPixels(metres: number, distance: number) {
  const angle = 2 * Math.atan(metres / 2 / Math.max(distance, 1)) * (180 / Math.PI)
  return { angle, pixels: (angle / 60) * 850 }
}

const runLength = () => distanceBetween(state.a, state.b)
const runHeading = () => bearingBetween(state.a, state.b)
const runCentre = () => destination(state.a, runHeading(), runLength() / 2)

// ── Map ──────────────────────────────────────────────────────────────────────

const map = L.map('map', { zoomControl: true }).setView([startCentre.lat, startCentre.lon], 16)

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map)

const pin = (colour: string, letter: string) => L.divIcon({
  className: '',
  html: `<div style="width:22px;height:22px;border-radius:50%;background:${colour};
    border:2px solid #0d1117;display:grid;place-items:center;color:#0d1117;
    font:600 11px system-ui">${letter}</div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

const startPin = L.marker([state.a.lat, state.a.lon], {
  draggable: true, icon: pin('#f0883e', 'A'), zIndexOffset: 1000,
}).addTo(map)

const endPin = L.marker([state.b.lat, state.b.lon], {
  draggable: true, icon: pin('#3fb950', 'B'), zIndexOffset: 900,
}).addTo(map)

const runLine = L.polyline([], {
  color: '#3fb950', weight: 1.5, dashArray: '5 6', opacity: 0.8,
}).addTo(map)
const circuitLine = L.polyline([], { color: '#58a6ff', weight: 2.5, opacity: 0.95 }).addTo(map)

/** Convert the flight path's local metres (east = +x, north = -z) to lat/lon. */
function toLatLon(centre: { lat: number; lon: number }, x: number, z: number) {
  return destination(destination(centre, 0, -z), 90, x)
}

function circuitOutline() {
  const centre = runCentre()
  const circuit = createCircuit({
    shape: 'racetrack',
    heading: runHeading(),
    length: runLength(),
    turnRadius: state.turnRadius,
    altitude: state.altitude,
    speed: state.speed,
    // Unused by a racetrack, but the option type wants them.
    radius: 0,
    period: 1,
  })
  const points: [number, number][] = []
  const steps = 160
  for (let i = 0; i <= steps; i += 1) {
    const p = circuit.positionAt((circuit.lapTime * i) / steps)
    const { lat, lon } = toLatLon(centre, p.x, p.z)
    points.push([lat, lon])
  }
  return { points, lapTime: circuit.lapTime, perimeter: circuit.perimeter }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  const heading = runHeading()
  const length = runLength()
  const centre = runCentre()
  const { points, lapTime, perimeter } = circuitOutline()

  circuitLine.setLatLngs(points)
  runLine.setLatLngs([[state.a.lat, state.a.lon], [state.b.lat, state.b.lon]])

  el('r-anchor').textContent = `${centre.lat.toFixed(7)}, ${centre.lon.toFixed(7)}`
  el('r-heading').textContent = `${heading.toFixed(1)}° ${compassPoint(heading)}`
  el('r-length').textContent = `${length.toFixed(0)} m`
  el('r-apart').textContent = `${(state.turnRadius * 2).toFixed(0)} m`
  // The bundled aircraft is about a third wingspan to overall length.
  el('r-span').textContent = `${(state.size * 0.36).toFixed(0)} m`
  el('r-lap').textContent = `${perimeter.toFixed(0)} m · ${lapTime.toFixed(0)}s`

  input('length').value = String(Math.round(length))
  el('v-length').textContent = `${length.toFixed(0)} m`
  el('v-turn').textContent = `${state.turnRadius} m`
  el('v-alt').textContent = `${state.altitude} m`
  el('v-speed').textContent = `${state.speed} m/s`
  el('v-size').textContent = `${state.size} m`
  el('v-viewer').textContent = `${state.viewer} m`

  const whole = apparentPixels(state.size, state.viewer)
  // The banner is roughly a fifth of the assembly's length in height, and it is
  // the part that has to be legible.
  const banner = apparentPixels(state.size * 0.2, state.viewer)
  el('apparent').innerHTML = `From ${state.viewer} m the aircraft spans about `
    + `<b>${whole.pixels.toFixed(0)} px</b> (${whole.angle.toFixed(1)}°), and the banner `
    + `stands about <b>${banner.pixels.toFixed(0)} px</b> tall. `
    + (banner.pixels < 20
      ? 'Lettering will not be readable at that size.'
      : 'Large lettering should read.')

  /*
   * Only parameters this project actually reads.
   *
   * `lat`/`lon` are gps-anchor.ts; `heading`, `length`, `turn`, `alt` and
   * `speed` are flight-motion.ts. Deliberately absent: `size` (nothing reads
   * it — the model's scale is set in .expanse.json), `mode` and `sim` (the
   * original's relative-placement and simulated-GPS modes were not ported),
   * and `elev` (gps-anchor does read it, but location.ts has no elevation
   * field for the snippet to set, so the URL and the shipped config would
   * disagree — 0 is right for an installation on the ground). gps-anchor's
   * `minacc`/`avg`/`smooth`/`smoothrot` and flight-motion's `bank`/`rolltime`/
   * `path` are tuning knobs with sensible defaults, not placement, so they are
   * left off too — add them by hand when you need them.
   */
  const query = new URLSearchParams({
    lat: centre.lat.toFixed(7),
    lon: centre.lon.toFixed(7),
    heading: heading.toFixed(1),
    length: length.toFixed(0),
    turn: String(state.turnRadius),
    alt: String(state.altitude),
    speed: String(state.speed),
  })

  /*
   * Resolve against the containing directory rather than string-stripping
   * "setup.html": a server may also serve this page at /setup, where the strip
   * silently fails and every emitted link points back here instead of at the
   * AR page. new URL('.') drops the last segment whatever it is called.
   */
  const base = new URL('.', location.href).href
  const url = `${base}?${query}`
  input('url').value = url
  el<HTMLAnchorElement>('open-ar').href = url

  /*
   * A QR pointing at localhost is useless: scanned on a phone it resolves to
   * the phone. Say so rather than letting it fail mysteriously.
   */
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname)
  el('qr-warning').hidden = !local
  el('qr-note').hidden = local

  QRCode.toCanvas(el<HTMLCanvasElement>('qr'), url, { width: 104, margin: 0 }).catch(() => {})

  /*
   * Every value the sliders control, as TypeScript you can actually paste over
   * the matching exports in src/location.ts.
   */
  const site = input('label').value.trim()
  input('snippet').value = [
    ...(site ? [`/** Set from setup.html: ${site} */`] : []),
    'export const INSTALLATION = {',
    `  lat: ${centre.lat.toFixed(7)},`,
    `  lon: ${centre.lon.toFixed(7)},`,
    '};',
    '',
    `export const FLIGHT_HEADING = ${heading.toFixed(1)};`,
    '',
    'export const FLIGHT = {',
    `  length: ${length.toFixed(0)},`,
    `  turnRadius: ${state.turnRadius},`,
    `  altitude: ${state.altitude},`,
    `  speed: ${state.speed},`,
    `  size: ${state.size},`,
    '};',
  ].join('\n')

  /*
   * The same numbers again, in the shape .expanse.json wants them.
   *
   * location.ts only feeds the components' `schemaDefaults`, and a scene
   * object's saved `parameters` override those — so editing location.ts alone
   * changes nothing at all on the deployed page. This is the second half of
   * the paste, and the reason the "Ship it" section is two boxes.
   */
  input('scene').value = [
    'src/.expanse.json  (or the same fields in Studio)',
    '',
    'entity "GPS Anchor" → gps-anchor',
    `  "latitude":   ${centre.lat.toFixed(7)},`,
    `  "longitude":  ${centre.lon.toFixed(7)},`,
    '',
    'entity "Motion" → flight-motion',
    `  "length":     ${length.toFixed(0)},`,
    `  "turnRadius": ${state.turnRadius},`,
    `  "altitude":   ${state.altitude},`,
    `  "speed":      ${state.speed},`,
    `  "heading":    ${heading.toFixed(1)},`,
  ].join('\n')
}

// ── Interaction ──────────────────────────────────────────────────────────────

// Either pin can be dragged; the run is simply the line between them.
startPin.on('drag', () => {
  const { lat, lng } = startPin.getLatLng()
  state.a = { lat, lon: lng }
  render()
})
endPin.on('drag', () => {
  const { lat, lng } = endPin.getLatLng()
  state.b = { lat, lon: lng }
  render()
})

// The length slider walks B along the current bearing, leaving A where it is.
input('length').addEventListener('input', (event) => {
  state.b = destination(state.a, runHeading(), Number((event.target as HTMLInputElement).value))
  endPin.setLatLng([state.b.lat, state.b.lon])
  render()
})

const knobs = [
  ['turn', 'turnRadius'],
  ['alt', 'altitude'],
  ['speed', 'speed'],
  ['size', 'size'],
  ['viewer', 'viewer'],
] as const

for (const [id, key] of knobs) {
  const slider = input(id)
  slider.value = String(state[key])
  slider.addEventListener('input', () => {
    state[key] = Number(slider.value)
    render()
  })
}

el('label').addEventListener('input', render)

el('jump').addEventListener('change', (event) => {
  const value = (event.target as HTMLInputElement).value
  const match = value.match(/(-?[0-9]+(?:[.][0-9]+)?)\s*,\s*(-?[0-9]+(?:[.][0-9]+)?)/)
  if (!match) return
  centreOn(Number(match[1]), Number(match[2]), 15)
})

/** Recentre the run on a point, keeping its length and bearing. */
function centreOn(lat: number, lon: number, zoom: number) {
  const heading = runHeading()
  const half = runLength() / 2
  state.a = destination({ lat, lon }, (heading + 180) % 360, half)
  state.b = destination({ lat, lon }, heading, half)
  startPin.setLatLng([state.a.lat, state.a.lon])
  endPin.setLatLng([state.b.lat, state.b.lon])
  map.setView([lat, lon], Math.max(map.getZoom(), zoom))
  render()
}

/*
 * Saves looking your own coordinates up. Worth the warning though: on a laptop
 * this is derived from the network and can be a kilometre out, so it is a way
 * to get the map roughly to the right place, not to set a final anchor.
 */
el('locate').addEventListener('click', () => {
  const status = el('locate-status')
  if (!navigator.geolocation) {
    status.textContent = 'This browser has no geolocation.'
    return
  }
  status.textContent = 'Locating…'
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      centreOn(coords.latitude, coords.longitude, 16)
      /*
       * Lead with the accuracy, not the coordinates. The fix itself is exact to
       * within a centimetre by the time it reaches the URL; what makes "use my
       * location" land in the wrong place is the reading, and on anything
       * without a GPS chip that is a WiFi or IP lookup that can be a kilometre
       * out. The number people need to see is the plus-or-minus.
       */
      const accuracy = coords.accuracy
      const quality = accuracy <= 25 ? 'ok' : accuracy <= 150 ? 'rough' : 'bad'
      status.dataset.quality = quality
      status.innerHTML = `<b>±${accuracy.toFixed(0)} m</b> — `
        + `${coords.latitude.toFixed(7)}, ${coords.longitude.toFixed(7)}`
        + (quality === 'ok'
          ? ''
          : quality === 'rough'
            ? '<br>Too coarse to anchor with. Drag the pins to the real spot.'
            : '<br>This is a network lookup, not GPS, and may be nowhere near you. '
              + 'Open this page on a phone for a real fix, or drag the pins.')
    },
    (error) => {
      status.textContent = error.code === error.PERMISSION_DENIED
        ? 'Location permission denied.'
        : `Could not get a location: ${error.message}`
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
  )
})

const copy = (button: HTMLElement, source: string) => button.addEventListener('click', async () => {
  await navigator.clipboard.writeText(input(source).value)
  const original = button.textContent
  button.textContent = 'Copied'
  setTimeout(() => { button.textContent = original }, 1200)
})
copy(el('copy-url'), 'url')
copy(el('copy-snippet'), 'snippet')
copy(el('copy-scene'), 'scene')

/*
 * A QR big enough to be worth printing or putting on a slide.
 *
 * The on-screen one is 104px, sized to be scanned off the monitor next to you.
 * This renders the same link to an offscreen canvas at 2048px and downloads it.
 * margin: 2 keeps the quiet zone a scanner needs once the image is cropped into
 * a layout — without it, artwork butting up against the pattern stops it
 * reading.
 */
el('export-qr').addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement
  const original = button.textContent
  try {
    const canvas = document.createElement('canvas')
    await QRCode.toCanvas(canvas, input('url').value, { width: 2048, margin: 2 })
    const link = document.createElement('a')
    link.download = 'tccc-ar-qr.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
    button.textContent = 'Downloaded'
  } catch (error) {
    button.textContent = `Failed: ${(error as Error).message}`
  }
  setTimeout(() => { button.textContent = original }, 1600)
})

render()

// Exposed for smoke testing from the console.
;(window as any).__setup = {
  state,
  render,
  map,
  get heading() { return runHeading() },
  get length() { return runLength() },
  get centre() { return runCentre() },
  get outline() { return circuitOutline() },
}
