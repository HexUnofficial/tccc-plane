/**
 * The device's position, as a local tangent-plane offset in true metres.
 *
 * Replaces what LocAR did for tccc-ar-test — watching the GPS, rejecting bad
 * fixes, and averaging recent ones — since 8th Wall's open-source runtime has
 * no geospatial layer at all (its documented Map/MapPoint components are part
 * of the hosted Niantic Maps product and are absent from @8thwall/ecs).
 *
 * The projection is the same local tangent plane as tccc-ar-test's
 * projection.js, and for the same reason: Web Mercator's "metres" are
 * inflated by sec(latitude), so at 51°N content placed 20 m away renders
 * 32 m away and reads far too small.
 */
const R = 6371008.8
const degToRad = (d: number) => (d * Math.PI) / 180

export type Fix = { lat: number; lon: number; accuracy: number }

let latest: Fix | null = null
/** Bumped on every accepted fix, so consumers can tell a new one from a repeat. */
let seq = 0
let error: string | null = null
let watchId: number | null = null

const recent: Fix[] = []
let averageFixes = 3
let minAccuracy = 100

/**
 * Stand in for the sensor with a fixed fix.
 *
 * `?sim=1` exists because 8th Wall Studio's own simulator supplies a camera
 * and a tracked pose but no GPS or magnetometer, so without this the
 * experience sits forever on "Waiting for GPS". It fakes the two sensors the
 * simulator does not, which is the desktop half of what tccc-ar-test's
 * `?sim=1` did; the drag-to-look and WASD half is Studio's job here.
 */
export function simulateFix(fix: Fix) {
  latest = fix
  error = null
  seq += 1
}

export function startGps(options: {
  minAccuracy?: number; averageFixes?: number; simulate?: boolean
} = {}) {
  if (watchId !== null) return
  minAccuracy = options.minAccuracy ?? minAccuracy
  averageFixes = Math.max(1, Math.round(options.averageFixes ?? averageFixes))

  if (options.simulate) return

  if (!navigator.geolocation) {
    error = 'This browser has no Geolocation API.'
    return
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords
      // A fix worse than this is worse than no fix: the content would visibly
      // wander by more than its own size.
      if (accuracy > minAccuracy) return

      error = null
      recent.push({ lat: latitude, lon: longitude, accuracy })
      while (recent.length > averageFixes) recent.shift()

      /*
       * Average the last few fixes rather than following each one.
       *
       * A deadband was tried in tccc-ar-test and rejected: at walking pace a
       * fix moves about 1.4 m/s, well inside any threshold big enough to
       * suppress noise, so it swallowed real walking. Averaging cannot
       * confuse the two — random error cancels as root n while steady
       * movement passes through with a fixed lag of about half the window.
       */
      const sum = recent.reduce(
        (acc, fix) => ({
          lat: acc.lat + fix.lat,
          lon: acc.lon + fix.lon,
          accuracy: acc.accuracy + fix.accuracy,
        }),
        { lat: 0, lon: 0, accuracy: 0 },
      )
      latest = {
        lat: sum.lat / recent.length,
        lon: sum.lon / recent.length,
        accuracy: sum.accuracy / recent.length,
      }
      seq += 1
    },
    (err) => {
      error = err.code === err.PERMISSION_DENIED
        ? 'Location permission denied — allow it and reload.'
        : `Lost GPS: ${err.message}`
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  )
}

export const getFix = () => latest
export const getFixSeq = () => seq
export const getError = () => error

/**
 * Metres east and north from `from` to `to`, on a plane tangent at `from`.
 * Accurate to millimetres over the few hundred metres an AR session covers.
 */
export function toLocalMetres(from: Fix | { lat: number; lon: number }, to: { lat: number; lon: number }) {
  return {
    east: degToRad(to.lon - from.lon) * R * Math.cos(degToRad(from.lat)),
    north: degToRad(to.lat - from.lat) * R,
  }
}
