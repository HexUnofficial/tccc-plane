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

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number }

let heading: number | null = null
let started = false

/** Degrees the page is rotated relative to the device's natural orientation. */
const screenAngle = () => screen.orientation?.angle ?? 0

function onOrientation(event: CompassEvent) {
  // iOS: a true-north heading, clockwise, already corrected for screen
  // orientation by the platform.
  if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading
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

/** Degrees clockwise from true north, or null before the first reading. */
export function getHeading(): number | null {
  return heading
}
