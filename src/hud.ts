import * as ecs from '@8thwall/ecs'
import { bearingBetween, compassPoint, destination, distanceBetween } from './geo'
import { getError, getFix } from './gps'
import { getHeading } from './compass'
import { FlightMotion } from './flight-motion'
import { halfExtentsFor, requestedSize } from './model'
import { INSTALLATION } from './location'

const params = new URLSearchParams(location.search)
const num = (key: string, fallback: number) => {
  const v = Number.parseFloat(params.get(key) ?? '')
  return Number.isFinite(v) ? v : fallback
}

/**
 * How much interface to draw over the camera feed, matching tccc-ar-test:
 *   none     the arrow alone (the default — over a live feed in front of an
 *            audience, the arrow is the only overlay that earns its place)
 *   minimal  the arrow, plus a banner when something is actually wrong
 *   debug    everything, including the telemetry panel
 */
let ui = params.get('ui') ?? 'none'

/** Past this, walking is imperceptible and it reads as "the AR is broken". */
const FAR_WARNING = num('farwarn', 1500)

const el = (id: string) => document.getElementById(id)

/** Metres under a kilometre, kilometres above it. */
export const formatDistance = (m: number) =>
  (m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(2)} km`)

/*
 * The arrow needs the model's whole extent, not its origin: the centre of a
 * banner-towing aeroplane is the empty middle of the tow line, so testing the
 * centre made the arrow appear while the aircraft was still plainly in view.
 * Shared with model-scale.ts so `?size=` moves both the model and this box.
 */
const SIZE = requestedSize()
const HALF = halfExtentsFor(SIZE)

type Cam = {
  projectionMatrix: { elements: ArrayLike<number> }
  matrixWorldInverse: { elements: ArrayLike<number> }
  fov?: number
}

/**
 * World point to clip space, by hand.
 *
 * three.js is not a dependency here — the engine bundles its own copy — but
 * the active camera it exposes is a real three.js camera, so its matrices can
 * be read and applied directly. Elements are column-major: m[row][col] is
 * e[col * 4 + row].
 */
function project(cam: Cam, x: number, y: number, z: number) {
  const apply = (e: ArrayLike<number>, v: number[]) => [0, 1, 2, 3].map(
    (r) => e[r] * v[0] + e[4 + r] * v[1] + e[8 + r] * v[2] + e[12 + r] * v[3],
  )
  const view = apply(cam.matrixWorldInverse.elements, [x, y, z, 1])
  const clip = apply(cam.projectionMatrix.elements, view)
  return { x: clip[0], y: clip[1], w: clip[3] }
}

const motionQuery = ecs.defineQuery([FlightMotion])

let smoothedFps = 60
let lastText = ''
let lastTone = ''
const lastField: Record<string, string> = {}

function setField(id: string, value: string) {
  if (lastField[id] === value) return
  lastField[id] = value
  const node = el(`f-${id}`)
  if (node) node.textContent = value
}

function setStatus(text: string, tone: string) {
  if (text === lastText && tone === lastTone) return
  lastText = text
  lastTone = tone
  const node = el('status')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
  node.hidden = !text
}

let chromeWired = false

function wireChrome() {
  if (chromeWired) return
  chromeWired = true
  const toggle = el('panel-toggle')
  const panel = el('panel')
  if (!toggle || !panel) return
  const applyChrome = () => {
    toggle.hidden = ui !== 'debug'
    panel.hidden = ui !== 'debug'
  }
  toggle.addEventListener('click', () => {
    ui = ui === 'debug' ? 'minimal' : 'debug'
    applyChrome()
  })
  applyChrome()
}

ecs.registerBehavior((world) => {
  wireChrome()

  const arrow = el('arrow')
  const arrowGlyph = arrow?.querySelector('svg') as SVGElement | null
  const arrowLabel = el('arrow-label')

  const dt = world.time.delta / 1000
  if (dt > 0) smoothedFps += (1 / dt - smoothedFps) * 0.1

  const fix = getFix()
  const heading = getHeading()
  // Must resolve the anchor the same way gps-anchor.ts does, or the readout
  // and the warning describe a different place from the one being rendered.
  const relative = params.get('mode') === 'relative'
  const anchor = fix && relative
    ? destination(fix, num('bearing', 0), num('distance', 400))
    : { lat: num('lat', INSTALLATION.lat), lon: num('lon', INSTALLATION.lon) }
  const distance = fix ? distanceBetween(fix, anchor) : null

  /*
   * Being in the wrong place looks identical to the AR being broken: a big
   * number that barely moves, and no model anywhere. Say which it is. In
   * relative mode the anchor follows you, so the warning cannot apply.
   */
  const tooFar = !relative && distance !== null && distance > FAR_WARNING

  let text = ''
  let tone = 'neutral'
  const gpsError = getError()
  if (gpsError) {
    text = gpsError
    tone = 'error'
  } else if (!fix) {
    text = 'Waiting for GPS…'
    tone = 'warn'
  } else if (heading === null) {
    text = 'Waiting for the compass — wave the phone in a figure-eight.'
    tone = 'warn'
  } else if (tooFar) {
    text = `${formatDistance(distance!)} from the installation — you are not at the site.`
    tone = 'warn'
  }

  const worthInterrupting = tone === 'warn' || tone === 'error'
  setStatus(ui === 'debug' || (ui === 'minimal' && worthInterrupting) ? text : '', tone)

  // --- Where the aircraft is, and how big it looks from here ---------------
  const motionEids = motionQuery(world)
  const camera = world.three.activeCamera as unknown as Cam | undefined
  let subject: { range: number; pixels: number } | null = null

  if (motionEids.length > 0 && camera && fix && heading !== null) {
    const eid = motionEids[0]
    const centre = world.transform.getWorldPosition(eid)
    const rotation = world.transform.getWorldQuaternion(eid)
    const cameraEid = world.camera.getActiveEid()
    const eye = world.transform.getWorldPosition(cameraEid)
    const range = centre.distanceTo(eye)

    const fov = camera.fov ?? 60
    const angular = 2 * Math.atan(SIZE / 2 / Math.max(range, 0.1))
    const pixels = angular * (world.three.renderer.domElement.clientHeight / ((fov * Math.PI) / 180))
    subject = { range, pixels }

    /*
     * On-screen is decided by the bounding box, not the centre. Project all
     * eight corners; if any lands inside the frustum the model is visible.
     * Corners behind the camera (w <= 0) are simply not counted as visible,
     * which is the case the naive centre test got wrong.
     */
    let onScreen = false
    for (let i = 0; i < 8 && !onScreen; i += 1) {
      const local = ecs.math.vec3.xyz(
        (i & 1 ? 1 : -1) * HALF.x,
        (i & 2 ? 1 : -1) * HALF.y,
        (i & 4 ? 1 : -1) * HALF.z,
      )
      const world3 = rotation.timesVec(local)
      const p = project(camera, centre.x + world3.x, centre.y + world3.y, centre.z + world3.z)
      if (p.w > 0 && Math.abs(p.x) <= p.w && Math.abs(p.y) <= p.w) onScreen = true
    }

    if (arrow && arrowGlyph && arrowLabel) {
      arrow.hidden = onScreen
      if (!onScreen) {
        const c = project(camera, centre.x, centre.y, centre.z)
        // project() mirrors anything behind the camera, so un-mirror it.
        const sign = c.w < 0 ? -1 : 1
        const ndcX = (sign * c.x) / Math.abs(c.w || 1e-6)
        const ndcY = (sign * c.y) / Math.abs(c.w || 1e-6)
        arrowGlyph.style.rotate = `${((Math.atan2(ndcX, ndcY) * 180) / Math.PI).toFixed(1)}deg`
        arrowLabel.textContent = formatDistance(range)
      }
    }
  } else if (arrow) {
    arrow.hidden = true
  }

  if (ui !== 'debug') return

  setField('fix', fix ? `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}` : '—')
  setField('accuracy', fix ? `±${fix.accuracy.toFixed(0)} m` : '—')
  setField('heading', heading === null ? '—' : `${heading.toFixed(0)}° ${compassPoint(heading)}`)
  setField('anchor', `${anchor.lat.toFixed(6)}, ${anchor.lon.toFixed(6)}`)
  setField('distance', distance === null ? '—' : formatDistance(distance))
  setField('bearing', fix
    ? `${bearingBetween(fix, anchor).toFixed(0)}° ${compassPoint(bearingBetween(fix, anchor))}`
    : '—')
  setField('subject', subject
    ? `${formatDistance(subject.range)} · ${subject.pixels.toFixed(0)} px`
    : '—')
  setField('fps', smoothedFps.toFixed(0))
})
