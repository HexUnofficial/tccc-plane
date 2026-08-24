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

import { num } from './config'

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number }

let heading: number | null = null
let started = false

/** Degrees the page is rotated relative to the device's natural orientation. */
const screenAngle = () => screen.orientation?.angle ?? 0

function onOrientation(event: CompassEvent) {
  /*
   * iOS: a true-north heading, clockwise — but in the *device's* frame, not
   * the interface's.
   *
   * This used to be taken as-is, on the belief that the platform had already
   * accounted for the screen being rotated. It has not. Turn the phone to
   * landscape and the device frame turns with it while the camera keeps
   * pointing the same way, so the reading moves by the same 90° the interface
   * did — and the whole content frame rotates with it, which is an aeroplane
   * flying across the river instead of along it.
   *
   * LocAR, which is what tccc-ar-test anchored with, corrects this explicitly:
   * it offsets the heading by ∓90° for a screen angle of ±90 (see
   * `orientationOffset` in its DeviceOrientationControls). Same correction as
   * the alpha branch below, and a no-op in portrait, where the angle is 0.
   */
  if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
    heading = (event.webkitCompassHeading + screenAngle()) % 360
    return
  }

  // Android and desktop: alpha counts anticlockwise from north in the
  // device's natural orientation, so it needs inverting and un-rotating.
  // `absolute` matters — a relative-only event is referenced to wherever the
  // device happened to be, which is worse than useless for finding north.
  if (event.absolute && typeof event.alpha === 'number') {
    heading = (360 - event.alpha + screenAngle()) % 360
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
const NORTH_OFFSET = num('north', 0)

/** Degrees clockwise from true north, or null before the first reading. */
export function getHeading(): number | null {
  if (heading === null) return null
  return (((heading + NORTH_OFFSET) % 360) + 360) % 360
}
