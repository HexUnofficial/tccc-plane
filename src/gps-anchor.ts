import * as ecs from '@8thwall/ecs'
import { startCompass, getHeading, simulateHeading } from './compass'
import { startGps, getFix, getFixSeq, simulateFix, toLocalMetres } from './gps'
import { bearingBetween, destination } from './geo'
import { flag, num, placed, placedNum } from './config'
import {
  DEFAULT_MODE, INSTALLATION, RELATIVE_PLACEMENT, VIEW_FROM,
} from './location'

const { vec3, quat } = ecs.math

/**
 * Whether the two sensors are being stood in for — the map picker's "Preview
 * anywhere" link, and 8th Wall Studio's simulator, which supplies a tracked
 * pose but no GPS or magnetometer. Read once: it cannot change within a
 * session, and tick() needs it too.
 */
const SIMULATED = flag('sim', false)

/*
 * The two angles the whole georeference rests on, published for the telemetry
 * panel. Between them and the compass heading, a photograph of that panel says
 * whether a rotated flight path is a rotated *frame* — and if it is, which of
 * the two inputs is wrong. Reasoning about it from a description could not.
 */
let frameYaw = 0
let cameraYawDegrees = 0

/** Degrees the content frame is rotated by, and the camera's yaw within SLAM. */
export const getFrameYaw = () => (frameYaw * 180) / Math.PI
export const getCameraYaw = () => cameraYawDegrees

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
    elevation: INSTALLATION.elevation,
    minAccuracy: 100,
    averageFixes: 3,
    headingSmoothing: 8,
    positionSmoothing: 1,
  },
  data: {
    yawOffset: 'f64',
    hasYaw: 'boolean',
    posX: 'f64',
    posZ: 'f64',
    hasPosition: 'boolean',
    /*
     * The camera's SLAM position at the moment of the last accepted fix, and
     * the ENU offset measured from that fix. Latched together so the anchor
     * can be rebuilt from where you *were* when the fix arrived rather than
     * from where you are now — see the note in tick().
     */
    fixSeq: 'f64',
    fixCamX: 'f64',
    fixCamZ: 'f64',
    fixEast: 'f64',
    fixNorth: 'f64',
    prevCamYaw: 'f64',
    hasPrevCamYaw: 'boolean',
  },
  add: (_w, { schema }) => {
    const simulate = SIMULATED
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
    const viewer = destination(
      anchor, num('viewfrom', VIEW_FROM), num('viewdist', RELATIVE_PLACEMENT.distance),
    )
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

    /*
     * Only re-estimate north while the device is reasonably still.
     *
     * targetYaw is the difference of two signals with different latencies: the
     * SLAM yaw is immediate, the compass lags it. Swing the phone and that
     * mismatch appears as a spurious change in the offset, which rotates the
     * entire content frame — and because the anchor is hundreds of metres
     * away, a couple of degrees of frame error throws the aircraft tens of
     * metres across the sky. The symptom is content that wheels around
     * whenever you turn.
     *
     * The offset is a constant, so nothing is lost by declining to measure it
     * mid-turn and waiting for the phone to settle.
     */
    const yawRate = data.hasPrevCamYaw && dt > 0
      ? Math.abs(Math.atan2(
        Math.sin(cameraYaw - data.prevCamYaw), Math.cos(cameraYaw - data.prevCamYaw),
      )) / dt
      : 0
    data.prevCamYaw = cameraYaw
    data.hasPrevCamYaw = true

    const STILL_ENOUGH = (25 * Math.PI) / 180 // radians per second

    if (!data.hasYaw) {
      data.yawOffset = targetYaw
      data.hasYaw = true
    } else if (!SIMULATED && yawRate < STILL_ENOUGH) {
      /*
       * Skipped entirely when simulating: targetYaw is β − ψ, and a stand-in
       * compass holds β constant, so every re-estimate is really just the
       * camera's own yaw. Smoothing towards it would drag the whole content
       * frame round to face you a few seconds after each turn of the phone.
       * The offset latched on the first frame leaves the circuit where it was
       * put, which is the entire point of a preview.
       */
      // Smooth on the shortest arc, so a reading either side of due north
      // averages through 0° rather than the long way round through 180°.
      let delta = targetYaw - data.yawOffset
      delta = Math.atan2(Math.sin(delta), Math.cos(delta))
      const tau = num('smoothrot', schema.headingSmoothing)
      data.yawOffset += delta * (tau > 0 ? 1 - Math.exp(-dt / tau) : 1)
    }

    const yaw = data.yawOffset
    frameYaw = yaw
    cameraYawDegrees = (cameraYaw * 180) / Math.PI

    /*
     * 'relative' ignores the installation coordinates and drops the circuit a
     * fixed distance from wherever you happen to be standing, so the whole
     * thing is testable in any car park. 'fixed' is what you deploy.
     */
    const target = (placed('mode') ?? DEFAULT_MODE) === 'relative'
      ? destination(
        fix,
        num('bearing', RELATIVE_PLACEMENT.bearing),
        num('distance', RELATIVE_PLACEMENT.distance),
      )
      : { lat: placedNum('lat', schema.latitude), lon: placedNum('lon', schema.longitude) }
    /*
     * Latch the offset and the camera position together, once per fix.
     *
     * Hanging the anchor off the *live* camera position every frame was wrong:
     * the GPS offset only changes when a fix lands, so between fixes the
     * anchor simply travelled with the camera. The content stayed a fixed
     * distance ahead of you however far you walked — no parallax, no approach,
     * and SLAM contributing nothing at all.
     *
     * Anchoring to where the camera *was* when the fix arrived instead leaves
     * the anchor still in the SLAM frame, so walking moves you relative to it
     * and the tracker does the work between fixes. That is the whole point of
     * having a tracker underneath.
     */
    const seq = getFixSeq()
    if (data.fixSeq !== seq) {
      const { east, north } = toLocalMetres(fix, target)
      const camera = w.transform.getWorldPosition(cameraEid)
      data.fixSeq = seq
      data.fixCamX = camera.x
      data.fixCamZ = camera.z
      data.fixEast = east
      data.fixNorth = north
    }

    // Local ENU offset (north = −Z, east = +X, matching flight-path.ts),
    // rotated into the SLAM frame. Recomputed every frame because `yaw` is
    // still converging, but always about the latched camera position.
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)
    const targetX = data.fixCamX + data.fixEast * cos + -data.fixNorth * sin
    const targetZ = data.fixCamZ + -data.fixEast * sin + -data.fixNorth * cos

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

    entity.setLocalPosition(vec3.xyz(data.posX, placedNum('elev', schema.elevation), data.posZ))
    entity.set(ecs.Quaternion, quat.yRadians(yaw))
  },
})
