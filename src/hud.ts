import * as ecs from '@8thwall/ecs'
import { bearingBetween, compassPoint, destination, distanceBetween } from './geo'
import { getError, getFix } from './gps'
import { getCompassState, getHeading } from './compass'
import { alignRunWithCamera, getCameraYaw, getFrameYaw, isAligned } from './gps-anchor'
import { FlightMotion } from './flight-motion'
import { halfExtentsFor, requestedSize } from './model'
import { modelIsInScene } from './model-ready'
import { DEFAULT_MODE, FLIGHT_HEADING, INSTALLATION, RELATIVE_PLACEMENT } from './location'
import { flag, linkIgnored, num, params, placed, placedNum } from './config'

/**
 * How much interface to draw over the camera feed, matching tccc-ar-test:
 *   none     the arrow alone, nothing else, ever
 *   minimal  the arrow, plus a banner when something is actually wrong
 *   debug    everything, including the telemetry panel
 *
 * tccc-ar-test defaults to `none`, reasoning that over a live camera feed in
 * front of an audience the arrow is the only overlay that earns its place. Its
 * own README admits what that costs: a denied permission or a lost fix then
 * says nothing at all. That cost is not hypothetical — being several km from
 * the installation looks exactly like broken AR, and in silence there is no
 * way to tell the two apart. `minimal` still shows nothing while things are
 * working, so it keeps the clean feed and speaks up only when it must.
 * `?ui=none` restores the original's behaviour.
 */
let ui = params.get('ui') ?? 'minimal'

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
const RUN_HEADING = placedNum('heading', FLIGHT_HEADING)

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
/*
 * The arrow's own state, kept across frames: whether it is up, when that last
 * changed (for the dwell), its unwrapped rotation, and whether the next frame
 * should snap to a new angle instead of sweeping to it.
 */
let arrowShown = false
let arrowChanged = 0
let arrowAngle = 0
let arrowSnap = true
let lastText = ''
let lastTone = ''
let lastBlocking = false
const lastField: Record<string, string> = {}

function setField(id: string, value: string) {
  if (lastField[id] === value) return
  lastField[id] = value
  const node = el(`f-${id}`)
  if (node) node.textContent = value
}

/**
 * `blocking` is the difference between a note and a screen: it means there is
 * nothing to look at yet and nothing to do but the thing the message says, so
 * it takes the middle of the display in the brand red rather than sitting in a
 * pill at the top.
 */
function setStatus(text: string, tone: string, blocking: boolean) {
  if (text === lastText && tone === lastTone && blocking === lastBlocking) return
  lastText = text
  lastTone = tone
  lastBlocking = blocking
  const node = el('status')
  if (!node) return
  node.textContent = text
  node.dataset.tone = tone
  node.dataset.blocking = String(blocking && Boolean(text))
  node.hidden = !text
}

let chromeWired = false

function wireChrome() {
  if (chromeWired) return
  chromeWired = true

  /*
   * Hidden unless asked for with `?align=1`. It is a repair tool for someone
   * standing at the site who can see that the run is wrong, not something a
   * member of the public should be handed a chance to press.
   */
  const align = el('align')
  if (align) {
    align.hidden = !flag('align', false)
    align.addEventListener('click', () => {
      alignRunWithCamera()
      align.textContent = 'Aligned'
      setTimeout(() => { align.textContent = 'Align to the run' }, 1400)
    })
  }

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
  /*
   * Must resolve the anchor the same way gps-anchor.ts does, or the readout and
   * the warning describe a different place from the one being rendered — down
   * to reading placement through `placed`/`placedNum`, so LOCKED suppresses it
   * here too, and to taking the defaults from RELATIVE_PLACEMENT rather than
   * carrying a second set of numbers.
   *
   * The one thing this cannot see is the component's own schema, which
   * .expanse.json overrides per entity; INSTALLATION is the nearest thing
   * available, and the two are kept in step by the map picker's "Ship it"
   * snippet setting both.
   */
  const relative = (placed('mode') ?? DEFAULT_MODE) === 'relative'
  const anchor = fix && relative
    ? destination(
      fix,
      num('bearing', RELATIVE_PLACEMENT.bearing),
      num('distance', RELATIVE_PLACEMENT.distance),
    )
    : { lat: placedNum('lat', INSTALLATION.lat), lon: placedNum('lon', INSTALLATION.lon) }
  const distance = fix ? distanceBetween(fix, anchor) : null

  /*
   * Being in the wrong place looks identical to the AR being broken: a big
   * number that barely moves, and no model anywhere. Say which it is. In
   * relative mode the anchor follows you, so the warning cannot apply.
   */
  const tooFar = !relative && distance !== null && distance > FAR_WARNING

  const motionEids = motionQuery(world)
  const modelInScene = modelIsInScene(world)

  let text = ''
  let tone = 'neutral'
  /*
   * Everything above `tooFar` stops the experience happening at all; being in
   * the wrong place does not — there is still an aircraft, somewhere over
   * there, and the arrow will point at it.
   */
  let blocking = true
  const gpsError = getError()
  if (gpsError) {
    text = gpsError
    tone = 'error'
  } else if (!fix) {
    text = 'Waiting for GPS…'
    tone = 'warn'
  } else if (heading === null) {
    // A phone held low reports a heading that is steady and meaningless, so
    // it is refused — and the only thing that fixes it is lifting the phone.
    text = getCompassState() === 'flat'
      ? 'Hold the phone up, camera towards the horizon.'
      : 'Waiting for the compass — wave the phone in a figure-eight.'
    tone = 'warn'
  } else if (!modelInScene) {
    // Ten megabytes of aeroplane over mobile data outlasts the gate's own
    // six-second timeout, so this is a normal state, not a broken one.
    text = 'Loading the aircraft…'
    tone = 'warn'
  } else if (tooFar) {
    text = `${formatDistance(distance!)} from the installation — you are not at the site.`
    tone = 'warn'
    blocking = false
  } else {
    blocking = false
  }

  const worthInterrupting = tone === 'warn' || tone === 'error'
  setStatus(ui === 'debug' || (ui === 'minimal' && worthInterrupting) ? text : '', tone, blocking)

  // --- Where the aircraft is, and how big it looks from here ---------------
  const camera = world.three.activeCamera as unknown as Cam | undefined
  let subject: { range: number; pixels: number } | null = null

  /*
   * `modelInScene` gates all of this, the arrow above all.
   *
   * The Motion entity exists from the first frame whether or not the GLB has
   * arrived, so without this the arrow spent the first several seconds
   * pointing, with total confidence, at an aeroplane that was still
   * downloading — and swinging as it flew its circuit invisibly. An arrow that
   * points at nothing is worse than no arrow: it is the one part of this that
   * a viewer has no way to check.
   */
  if (modelInScene && motionEids.length > 0 && camera && fix && heading !== null) {
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
     * On-screen is an overlap test between the model's projected rectangle and
     * the viewport — not "is any corner inside it".
     *
     * The corner-inside version was wrong in the case that matters most: when
     * the aircraft is close it is far bigger than the screen, so every one of
     * its eight corners falls outside the viewport while the thing fills the
     * view. The arrow then appeared, pointing at a centre that is the empty
     * middle of the tow line, and span wildly as the model swept past.
     *
     * Corners in front of the camera give a 2D rect; if that rect overlaps
     * [-1,1] on both axes, some part of the model is visible. A box with
     * corners on both sides of the camera plane straddles the viewer and
     * always counts as visible.
     */
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    let inFront = 0
    for (let i = 0; i < 8; i += 1) {
      const local = ecs.math.vec3.xyz(
        (i & 1 ? 1 : -1) * HALF.x,
        (i & 2 ? 1 : -1) * HALF.y,
        (i & 4 ? 1 : -1) * HALF.z,
      )
      const world3 = rotation.timesVec(local)
      const p = project(camera, centre.x + world3.x, centre.y + world3.y, centre.z + world3.z)
      if (p.w <= 0) continue
      inFront += 1
      const ndcX = p.x / p.w
      const ndcY = p.y / p.w
      minX = Math.min(minX, ndcX)
      maxX = Math.max(maxX, ndcX)
      minY = Math.min(minY, ndcY)
      maxY = Math.max(maxY, ndcY)
    }
    const straddles = inFront > 0 && inFront < 8
    const overlaps = (edge: number) =>
      maxX >= -edge && minX <= edge && maxY >= -edge && minY <= edge

    /*
     * Hysteresis, because a bare in-or-out test flickers.
     *
     * The aircraft crosses the view at tens of degrees a second, so its
     * projected rect sits exactly on the viewport edge for several frames on
     * the way past — and a test with one threshold then flips every frame,
     * which is the arrow and the model appearing to take turns. Showing the
     * arrow needs the model fully outside the viewport; hiding it again only
     * needs the model back inside a border a third wider. Nothing can sit on
     * both sides of that gap at once.
     */
    const MARGIN = 1.35
    const onScreen = inFront > 0 && (straddles || overlaps(arrowShown ? MARGIN : 1))

    if (arrow && arrowGlyph && arrowLabel) {
      /*
       * And a dwell, for the case the margin cannot cover: something moving
       * fast enough crosses the whole gap between frames. A quarter second is
       * beneath noticing when the state is real and long enough to swallow a
       * flip that is not.
       */
      const now = world.time.elapsed
      if (onScreen === arrowShown && now - arrowChanged > 250) {
        arrowShown = !onScreen
        arrowChanged = now
      }
      arrow.hidden = !arrowShown

      if (arrowShown) {
        const c = project(camera, centre.x, centre.y, centre.z)
        // project() mirrors anything behind the camera, so un-mirror it.
        const sign = c.w < 0 ? -1 : 1
        const ndcX = (sign * c.x) / Math.abs(c.w || 1e-6)
        const ndcY = (sign * c.y) / Math.abs(c.w || 1e-6)
        const target = (Math.atan2(ndcX, ndcY) * 180) / Math.PI

        /*
         * Track the angle unwrapped, so `rotate` never jumps by more than half
         * a turn.
         *
         * The glyph has a 120 ms CSS transition on it, and CSS interpolates
         * the number it is given: hand it 179° one frame and −179° the next —
         * which is what atan2 does every time the aircraft passes behind you —
         * and it animates 358° the long way round rather than 2° across. That
         * is the arrow spinning, and it spins hardest exactly when the target
         * is moving fastest. Accumulating the shortest arc keeps the number
         * continuous, so the transition always takes the short way.
         */
        let delta = target - arrowAngle
        delta -= 360 * Math.round(delta / 360)
        arrowAngle += delta

        // Reappearing after being hidden, the old angle is stale and nobody
        // watched it change — snap rather than sweep to the new one.
        if (arrowSnap) {
          arrowGlyph.style.transition = 'none'
          arrowAngle = target
        }
        arrowGlyph.style.rotate = `${arrowAngle.toFixed(1)}deg`
        if (arrowSnap) {
          // Read back a layout property to flush the snap before the
          // transition goes back on, or the browser coalesces the two and
          // animates from the stale angle anyway.
          void arrowGlyph.getBoundingClientRect()
          arrowGlyph.style.transition = ''
          arrowSnap = false
        }

        arrowLabel.textContent = formatDistance(range)
      } else {
        arrowSnap = true
      }
    }
  } else if (arrow) {
    arrow.hidden = true
    arrowShown = false
    arrowSnap = true
  }

  if (ui !== 'debug') return

  setField('fix', fix ? `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}` : '—')
  setField('accuracy', fix ? `±${fix.accuracy.toFixed(0)} m` : '—')
  setField('heading', heading === null ? '—' : `${heading.toFixed(0)}° ${compassPoint(heading)}`)
  /*
   * The bearing the circuit is actually flown on, which is a different
   * question from which way the compass thinks north is — and the one to
   * check first when the run looks rotated. If this does not match the
   * heading the map picker shows for the same pins, the link is stale and no
   * amount of compass correction will fix it; if it matches and the aircraft
   * still flies across the river, then it is the compass.
   *
   * Resolved the way flight-motion resolves it, minus the scene parameter it
   * cannot see: URL first, then the shipped default. .expanse.json holds the
   * same 114.5 as location.ts, so the two agree unless someone changes one.
   */
  setField('run', `${RUN_HEADING.toFixed(1)}° ${compassPoint(RUN_HEADING)}`)
  // Which numbers are in force. A link whose settings were discarded looks
  // identical to one that was obeyed, until you read this.
  setField('link', linkIgnored() ? 'ignored — using shipped' : 'honoured')
  setField('frameby', isAligned() ? 'aligned by hand' : 'compass')
  // The frame: how far the content is turned, and where SLAM thinks the camera
  // points. heading − camyaw should equal frame once it has settled; if it does
  // and the run is still across the river, the compass reading is the thing
  // that is wrong, not the arithmetic on it.
  setField('frame', `${getFrameYaw().toFixed(0)}°`)
  setField('camyaw', `${getCameraYaw().toFixed(0)}°`)
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
