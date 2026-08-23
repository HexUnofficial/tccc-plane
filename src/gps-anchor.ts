import * as ecs from '@8thwall/ecs'
import { startCompass, getHeading, simulateHeading } from './compass'
import { startGps, getFix, simulateFix, toLocalMetres } from './gps'
import { bearingBetween, destination } from './geo'
import { INSTALLATION } from './location'

const { vec3, quat } = ecs.math

const params = new URLSearchParams(location.search)
const num = (key: string, fallback: number) => {
  const value = Number.parseFloat(params.get(key) ?? '')
  return Number.isFinite(value) ? value : fallback
}

/**
 * Holds this entity at a real-world latitude and longitude, so that
 * everything parented under it is positioned in true metres of east/north.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * tccc-ar-test got GPS anchoring from LocAR. 8th Wall's open-source runtime
 * has no equivalent: `Map`/`MapPoint`/`GpsPointer` appear in its TypeScript
 * declarations but are not registered in @8thwall/ecs at runtime (confirmed
 * via ecs.listAttributes()) — they belong to the hosted Niantic Maps for Web
 * product. So the anchoring is done here by hand.
 *
 * ── How it works ──────────────────────────────────────────────────────────
 * 8th Wall's SLAM gives precise *relative* pose but its world frame starts at
 * an arbitrary yaw and its origin is wherever the session began. Two
 * corrections turn that into a georeferenced frame:
 *
 *   Heading — the compass says the camera faces true bearing β; SLAM says the
 *     camera faces yaw ψ within its own frame. Rotating this entity by
 *     (ψ − β) therefore makes its local −Z point at true north and +X at east.
 *     That difference should be a *constant*, so it is heavily smoothed: what
 *     we are really doing is estimating one fixed offset out of a noisy
 *     compass, not tracking a moving value.
 *
 *   Position — the GPS fix gives the offset in metres from the viewer to the
 *     installation. Placing this entity at the camera's SLAM position plus
 *     that offset (rotated into the SLAM frame) puts the anchor in the right
 *     place regardless of where the session started.
 *
 * Between fixes SLAM carries the motion, which is the one respect in which
 * this should feel *better* than the LocAR original: that version had to ease
 * between GPS fixes to avoid lurching, whereas here the tracker supplies
 * genuinely continuous movement and GPS only corrects the absolute position.
 */
export const GpsAnchor = ecs.registerComponent({
  name: 'gps-anchor',
  schema: {
    latitude: 'f64',
    longitude: 'f64',
    elevation: 'f32',
    minAccuracy: 'f32',
    averageFixes: 'f32',
    /** Seconds for the heading estimate to settle. Long, deliberately. */
    headingSmoothing: 'f32',
    /** Seconds for the position to ease to a corrected GPS fix. */
    positionSmoothing: 'f32',
  },
  schemaDefaults: {
    latitude: INSTALLATION.lat,
    longitude: INSTALLATION.lon,
    elevation: 0,
    minAccuracy: 100,
    averageFixes: 3,
    headingSmoothing: 4,
    positionSmoothing: 1,
  },
  data: {
    yawOffset: 'f64',
    hasYaw: 'boolean',
    posX: 'f64',
    posZ: 'f64',
    hasPosition: 'boolean',
  },
  add: (_w, { schema }) => {
    const simulate = params.get('sim') === '1'
    startGps({
      minAccuracy: num('minacc', schema.minAccuracy),
      averageFixes: num('avg', schema.averageFixes),
      simulate,
    })

    if (!simulate) {
      startCompass()
      return
    }

    /*
     * Stand off the anchor on `viewfrom`, the way a real spectator would —
     * standing due south of a run that happens to lie north-south means
     * watching it fly straight at you, which shows the least of it.
     */
    const anchor = { lat: schema.latitude, lon: schema.longitude }
    const viewer = destination(anchor, num('viewfrom', 180), num('viewdist', 400))
    simulateFix({ ...viewer, accuracy: 5 })
    simulateHeading(bearingBetween(viewer, anchor))
  },
  tick: (w, { eid, schema, data }) => {
    const entity = w.getEntity(eid)
    const fix = getFix()
    const heading = getHeading()

    // Until both sensors have reported, anything we drew would be in the
    // wrong place — which reads to a viewer as "the AR is broken" rather than
    // "the AR is still starting".
    if (!fix || heading === null) {
      entity.hide()
      return
    }
    entity.show()

    const dt = w.time.delta / 1000

    // Camera yaw within the SLAM frame, from its forward vector rather than
    // Euler angles, to sidestep any convention mismatch.
    const cameraEid = w.camera.getActiveEid()
    const forward = w.transform.getWorldQuaternion(cameraEid).timesVec(vec3.xyz(0, 0, -1))
    const cameraYaw = Math.atan2(forward.x, -forward.z)

    /*
     * Rotating local ENU by this lands it on the SLAM frame.
     *
     * quat.yRadians(θ) turns a direction at compass-style angle a into one at
     * a − θ (verified against the runtime; it is a right-handed rotation about
     * +Y, where compass bearings run the other way). Content at true bearing β
     * therefore lands at β − θ in the SLAM frame, and we want that to be the
     * camera's SLAM yaw ψ when the compass reads β — so θ = β − ψ.
     */
    const targetYaw = (heading * Math.PI) / 180 - cameraYaw

    if (!data.hasYaw) {
      data.yawOffset = targetYaw
      data.hasYaw = true
    } else {
      // Smooth on the shortest arc, so a reading either side of due north
      // averages through 0° rather than the long way round through 180°.
      let delta = targetYaw - data.yawOffset
      delta = Math.atan2(Math.sin(delta), Math.cos(delta))
      const tau = num('smoothrot', schema.headingSmoothing)
      data.yawOffset += delta * (tau > 0 ? 1 - Math.exp(-dt / tau) : 1)
    }

    const yaw = data.yawOffset

    /*
     * 'relative' ignores the installation coordinates and drops the circuit a
     * fixed distance from wherever you happen to be standing, so the whole
     * thing is testable in any car park. 'fixed' is what you deploy.
     */
    const target = params.get('mode') === 'relative'
      ? destination(fix, num('bearing', 0), num('distance', 400))
      : { lat: num('lat', schema.latitude), lon: num('lon', schema.longitude) }
    const { east, north } = toLocalMetres(fix, target)

    // Local ENU offset (north = −Z, east = +X, matching flight-path.ts),
    // rotated into the SLAM frame and hung off the camera's tracked position.
    const camera = w.transform.getWorldPosition(cameraEid)
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)
    const targetX = camera.x + east * cos + -north * sin
    const targetZ = camera.z + -east * sin + -north * cos

    if (!data.hasPosition) {
      data.posX = targetX
      data.posZ = targetZ
      data.hasPosition = true
    } else {
      const tau = num('smooth', schema.positionSmoothing)
      const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1
      data.posX += (targetX - data.posX) * k
      data.posZ += (targetZ - data.posZ) * k
    }

    entity.setLocalPosition(vec3.xyz(data.posX, num('elev', schema.elevation), data.posZ))
    entity.set(ecs.Quaternion, quat.yRadians(yaw))
  },
})
