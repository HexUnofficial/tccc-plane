/**
 * True-north heading from the device magnetometer.
 *
 * 8th Wall's SLAM tracking gives excellent *relative* orientation but its
 * world frame starts at an arbitrary yaw — it has no idea which way north is.
 * GPS anchoring needs absolute bearing, so we read the compass ourselves and
 * (in gps-anchor.ts) rotate the content frame by the difference.
 *
 * This is the weakest link in the whole chain, exactly as noted in
 * tccc-ar-test's README: iOS exposes a genuine true-north heading, Android
 * varies by device and can be tens of degrees out until the magnetometer is
 * calibrated by waving a figure-eight.
 */

import { num, placedNum } from './config'
import { COMPASS_OFFSET } from './location'
import { azimuthFrom } from './orientation'

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number }

let heading: number | null = null
let started = false

/*
 * ── SETTLING ──────────────────────────────────────────────────────────────
 *
 * The first readings out of a magnetometer are not to be trusted. iOS reports
 * a heading before the sensor has converged, and an uncalibrated Android can
 * be a quadrant out for a second or two — and gps-anchor latches its yaw from
 * the very first reading it is given, because that offset is supposed to be a
 * constant. Latch a bad one and the whole content frame starts wrong and then
 * creeps to correct over the smoothing time, which is an arrow that points
 * somewhere unhelpful at exactly the moment someone is deciding whether this
 * works at all.
 *
 * So a reading is not published until successive ones have agreed for a
 * while. Until then getHeading() answers null, which everything downstream
 * already handles: the anchor hides, the arrow stays down, and the HUD says
 * it is waiting for the compass.
 */
const STEADY_MS = num('steady', 1) * 1000
const STEADY_TOLERANCE = num('steadytol', 10)
/** But never wait forever: a noisy compass is still better than no start. */
const STEADY_LIMIT_MS = num('steadymax', 6) * 1000

let steady = false
let firstReadingAt = 0
let steadyFrom = 0
let steadyAround: number | null = null

/** Signed difference between two bearings, in [-180, 180). */
const arc = (degrees: number) => (((degrees + 180) % 360) + 360) % 360 - 180

function noteReading(value: number) {
  if (steady) return
  const now = performance.now()
  if (firstReadingAt === 0) firstReadingAt = now
  if (steadyAround === null || Math.abs(arc(value - steadyAround)) > STEADY_TOLERANCE) {
    steadyAround = value
    steadyFrom = now
    return
  }
  steady = now - steadyFrom >= STEADY_MS || now - firstReadingAt >= STEADY_LIMIT_MS
}

/** Degrees the page is rotated relative to the device's natural orientation. */
const screenAngle = () => screen.orientation?.angle ?? 0

/**
 * Both platforms end up in the same place: an absolute alpha — anticlockwise
 * about the vertical from north — which, with beta and gamma, gives the
 * camera's bearing however the phone is being held (see orientation.ts).
 *
 * iOS reports a relative alpha and a true-north compass heading separately, so
 * the compass supplies what alpha lacks. This is what LocAR does with its
 * `alphaOffset`, and taking the same route means the awkward cases — sideways,
 * tilted up at the sky — are handled by the same arithmetic that worked at
 * this site before.
 */
function onOrientation(event: CompassEvent) {
  const { beta, gamma } = event
  const tilted = typeof beta === 'number' && typeof gamma === 'number'

  if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
    const compass = event.webkitCompassHeading
    heading = tilted
      ? azimuthFrom(360 - compass, beta as number, gamma as number)
      // No tilt to work with: assume upright and portrait, and lean on the
      // screen angle, which is right unless the page is orientation-locked.
      : (compass + screenAngle()) % 360
    noteReading(heading)
    return
  }

  // `absolute` matters — a relative-only event is referenced to wherever the
  // device happened to be, which is worse than useless for finding north.
  if (event.absolute && typeof event.alpha === 'number') {
    heading = tilted
      ? azimuthFrom(event.alpha, beta as number, gamma as number)
      : (360 - event.alpha + screenAngle()) % 360
    noteReading(heading)
  }
}

function listen() {
  if (started) return
  started = true
  window.addEventListener('deviceorientationabsolute', onOrientation as EventListener)
  window.addEventListener('deviceorientation', onOrientation as EventListener)
}

/**
 * iOS 13+ refuses orientation events until an explicit grant, and the request
 * must happen inside a user gesture — so this is called from the gate's Start
 * button (see gate.ts), not on load.
 *
 * @returns whether readings can be expected. Android and desktop have no
 *   prompt and resolve true without asking.
 */
export async function requestCompassPermission(): Promise<boolean> {
  const api = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<PermissionState>
  }
  if (typeof api?.requestPermission === 'function') {
    try {
      if ((await api.requestPermission()) !== 'granted') return false
    } catch {
      return false
    }
  }
  listen()
  return true
}

/**
 * Start listening where no grant is needed. iOS will deliver nothing until
 * `requestCompassPermission` has been through the Start button.
 */
export function startCompass() {
  const api = window.DeviceOrientationEvent as unknown as { requestPermission?: unknown }
  if (typeof api?.requestPermission !== 'function') listen()
}

/** Stand in for the magnetometer. See `simulateFix` in gps.ts for why. */
export function simulateHeading(degrees: number) {
  heading = ((degrees % 360) + 360) % 360
  started = true
  // A stand-in never wanders, so there is nothing to wait for.
  steady = true
}

/**
 * A fixed correction added to every reading, from `?north=`.
 *
 * The magnetometer is the one part of this that cannot be verified from a
 * desk, and it is wrong in whole quadrants on some devices — held in
 * landscape, or with a case containing a magnet, or simply uncalibrated. When
 * the entire circuit sits at right angles to the river it is in, that is this
 * number, and waiting for a redeploy to test a guess at it is no way to spend
 * a site visit.
 *
 * To find it: open with `?ui=debug`, stand facing along the run, and compare
 * the panel's Heading with the bearing the map picker gives for the same run.
 * The difference is what goes here.
 */
const NORTH_OFFSET = placedNum('north', COMPASS_OFFSET)

/** Degrees clockwise from true north, or null before the first reading. */
export function getHeading(): number | null {
  if (heading === null || !steady) return null
  return (((heading + NORTH_OFFSET) % 360) + 360) % 360
}
