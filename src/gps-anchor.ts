import * as ecs from '@8thwall/ecs'
import { startCompass, getHeading, simulateHeading } from './compass'
import { startGps, getFix, getFixSeq, simulateFix, toLocalMetres } from './gps'
import { bearingBetween, destination } from './geo'
import { flag, num, placed, placedNum } from './config'
import {
  DEFAULT_MODE, FLIGHT_HEADING, INSTALLATION, RELATIVE_PLACEMENT, VIEW_FROM,
} from './location'

/** The bearing the circuit is flown on, resolved as flight-motion resolves it. */
const RUN_HEADING = placedNum('heading', FLIGHT_HEADING)

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
let entityYawDegrees = 0

/**
 * Where the camera points, taken from the camera that actually renders.
 *
 * There are two answers to this question and they are not required to agree.
 * `w.transform.getWorldQuaternion(cameraEid)` is the pose the entity system
 * holds; `w.three.activeCamera` is the three.js camera the frame is drawn
 * with, and the engine is free to apply the device's screen orientation to the
 * latter on its way to the screen. Reading the first while the picture comes
 * from the second puts the content frame a quarter turn out — and since the
 * screen orientation is whatever it was when the session started, that quarter
 * turn is a different one each time, which is exactly the fault being chased:
 * placement right, path square to it, and no two runs alike.
 *
 * The renderer's camera is the one to believe. It is the camera the aircraft
 * is projected through in hud.ts, which is why the arrow has always pointed at
 * the aircraft correctly however wrong the flight path looked. The entity pose
 * stays as a fallback, and is published beside it so the two can be compared
 * on the telemetry panel.
 */
function forwardOf(w: ecs.World, cameraEid: ecs.Eid) {
  const rendered = (w.three.activeCamera as unknown as {
    matrixWorld?: { elements: ArrayLike<number> }
  } | undefined)?.matrixWorld?.elements
  // Column-major: elements 8..10 are the camera's local +Z in world space, and
  // a camera looks down its own −Z.
  if (rendered) return { x: -rendered[8], y: -rendered[9], z: -rendered[10] }
  return w.transform.getWorldQuaternion(cameraEid).timesVec(vec3.xyz(0, 0, -1))
}

/*
 * ── ALIGNING BY HAND ──────────────────────────────────────────────────────
 *
 * Every sensor in this chain can be wrong in a way that cannot be detected
 * from inside: a magnetometer near steel, a platform reporting a heading in a
 * frame that is not the one documented, a tracker whose world yaw jumps with
 * the screen orientation. The symptom is always the same — the run sits at a
 * right angle to the river it was drawn on — and no amount of arithmetic on
 * bad input recovers it.
 *
 * A person standing at the site can see the river. Pointing the phone along
 * it and tapping says, in one gesture, "whatever your instruments claim, this
 * is where the run goes", and the frame is set from that: the direction the
 * camera faces *becomes* the circuit's heading. It needs no calibration, no
 * reload, and it cannot be wrong in a way the person holding it cannot see.
 *
 * Afterwards the compass is left to its own devices — re-estimating from it
 * would drag the frame back to the reading that was wrong in the first place.
 */
let alignRequested = false
let aligned = false

/*
 * ── THE COMPASS IS A STARTING GUN, NOT A STEERING WHEEL ────────────────────
 *
 * The offset between true north and the tracker's world is a *constant*: it
 * is a property of where the session began, and it cannot change while the
 * session runs. The compass is only a way of measuring it once.
 *
 * This used to keep re-measuring it for the whole session, on the reasoning
 * that averaging more readings gives a better estimate. That is true of a
 * sensor whose error is noise. A magnetometer's error is not noise — it is
 * bias, from whatever steel, wiring or magnets happen to be nearby, and it
 * changes as the person carrying it walks around. So the frame kept being
 * dragged towards each new reading, the flight path turned with it, and it did
 * so differently for every phone and every visit.
 *
 * Now the estimate runs for a few seconds, to average out the genuine noise
 * while the person is still getting their bearings, and then the frame is
 * locked and the tracker carries it. SLAM is far better at holding an
 * orientation over minutes than a compass is, which is the whole reason it is
 * underneath. `?lock=0` restores the old behaviour; `?lock=` sets the seconds.
 */
const LOCK_MS = num('lock', 6) * 1000
let firstHeadingAt = 0
let locked = false

/*
 * ── NORTH FROM WALKING, NOT FROM THE MAGNETOMETER ─────────────────────────
 *
 * This is the primary source. The compass only stands in until it arrives.
 *
 *
 * Locking the frame stops a wandering magnetometer from dragging it, but it
 * cannot rescue a reading that was wrong to begin with: a phone whose compass
 * is out by a right angle at the moment of the lock is out by a right angle
 * for the rest of the session, permanently and confidently.
 *
 * There is a second way to find north, and it does not involve the
 * magnetometer at all. Walk a few metres. GPS says that displacement had true
 * bearing X. The tracker says the same displacement had bearing Y inside its
 * own world. The difference between them is the offset between that world and
 * true north — which is precisely the number the compass was being asked for,
 * measured instead from two instruments that are trustworthy.
 *
 * It costs walking, and its accuracy is the GPS error over the distance
 * covered: a 5 m fix across a 12 m walk is worth about 25°, across 50 m about
 * 6°. So it takes the longest baseline it has seen and keeps improving as
 * someone walks further, each estimate replacing the last. Once one exists the
 * magnetometer is never consulted again — not for turning either, which the
 * tracker does far better than a compass can.
 *
 * Standing still it never arrives, which is why the compass still bootstraps
 * the first placement: something has to be on screen before anyone has taken a
 * step. That first placement is the only thing the compass is trusted with,
 * and the walk overrules it the moment it can.
 */
const WALK_MIN = num('walk', 12)

/**
 * Refuse to place anything until the walk has given us north.
 *
 * On by default, because the magnetometer has not earned the benefit of the
 * doubt: it has put the run square to the river on this device, differently
 * each session, and every attempt to correct its output has been a guess about
 * a sensor that cannot be read from here. The walk estimate does not involve
 * it, cannot be biased by steel or a phone case, and is checkable — GPS says
 * the walk went that way, the tracker agrees it went that way, and the angle
 * between the two answers is the only thing being asked for.
 *
 * The price is asking someone to take a dozen steps before the aircraft
 * appears, which is a normal thing for a geospatial experience to ask and a
 * great deal better than showing them a flight path at right angles to the
 * river. `?walkfirst=0` restores the old behaviour of trusting the compass.
 */
const WALK_FIRST = flag('walkfirst', true) && !SIMULATED

/** Metres walked so far, and how many are needed, for the message on screen. */
export const getWalkProgress = () => ({
  walked: walkedNow, needed: WALK_MIN, ready: walkYaw !== null, required: WALK_FIRST,
})
let walkOrigin: { lat: number; lon: number; camX: number; camZ: number } | null = null
let walkBaseline = 0
let walkYaw: number | null = null
/** How far from the start we are right now, accepted or not, for the counter. */
let walkedNow = 0

/** What is holding the content frame, for the telemetry panel. */
export const getFrameSource = () => {
  if (aligned) return 'aligned by hand'
  if (walkYaw !== null) return `walked ${walkBaseline.toFixed(0)} m`
  return locked ? 'compass, locked' : 'compass, settling'
}

/** Take the run's bearing from where the camera is pointing, once. */
export const alignRunWithCamera = () => { alignRequested = true }

/** Whether the frame is currently held by hand rather than by the compass. */
export const isAligned = () => aligned

/** Degrees the content frame is rotated by, and the camera's yaw within SLAM. */
export const getFrameYaw = () => (frameYaw * 180) / Math.PI
export const getCameraYaw = () => cameraYawDegrees
/** The entity system's camera yaw. Differing from the rendered one is the bug. */
export const getEntityYaw = () => entityYawDegrees

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

    /*
     * Until we know where things are *and* which way round they go, anything
     * drawn is in the wrong place — which reads as broken AR rather than as AR
     * that has not started. Under WALK_FIRST that includes knowing north from
     * the walk rather than from the magnetometer, so the aircraft waits for a
     * dozen steps instead of appearing somewhere confidently wrong.
     */
    const orientedByWalk = walkYaw !== null
    if (!fix || (WALK_FIRST ? !orientedByWalk : heading === null)) {
      entity.hide()
      // Still run the fix bookkeeping below, or the walk can never complete.
    } else {
      entity.show()
    }

    // A heading is still wanted for the compass bootstrap when WALK_FIRST is
    // off; with it on, everything below simply waits for the walk.
    if (heading === null && !WALK_FIRST) return

    const dt = w.time.delta / 1000

    // Camera yaw within the SLAM frame, from its forward vector rather than
    // Euler angles, to sidestep any convention mismatch.
    const cameraEid = w.camera.getActiveEid()
    const forward = forwardOf(w, cameraEid)
    const cameraYaw = Math.atan2(forward.x, -forward.z)

    // The entity system's answer to the same question, for comparison only.
    const entityForward = w.transform.getWorldQuaternion(cameraEid).timesVec(vec3.xyz(0, 0, -1))
    entityYawDegrees = (Math.atan2(entityForward.x, -entityForward.z) * 180) / Math.PI

    /*
     * Rotating local ENU by this lands it on the SLAM frame.
     *
     * quat.yRadians(θ) turns a direction at compass-style angle a into one at
     * a − θ (verified against the runtime; it is a right-handed rotation about
     * +Y, where compass bearings run the other way). Content at true bearing β
     * therefore lands at β − θ in the SLAM frame, and we want that to be the
     * camera's SLAM yaw ψ when the compass reads β — so θ = β − ψ.
     */
    // Only meaningful when the compass is in charge; under WALK_FIRST the
    // heading is null and nothing below reads this.
    const targetYaw = ((heading ?? 0) * Math.PI) / 180 - cameraYaw

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

    // From the first usable heading, the estimate has a limited life.
    if (firstHeadingAt === 0) firstHeadingAt = w.time.elapsed
    if (!locked && LOCK_MS > 0 && w.time.elapsed - firstHeadingAt >= LOCK_MS) locked = true

    if (alignRequested) {
      /*
       * The camera is pointing along the run, so the run's bearing has to come
       * out where the camera is looking: content at RUN_HEADING must land at
       * SLAM angle cameraYaw, and content at bearing b lands at b − yaw.
       */
      alignRequested = false
      aligned = true
      data.yawOffset = (RUN_HEADING * Math.PI) / 180 - cameraYaw
      data.hasYaw = true
    } else if (!WALK_FIRST && !data.hasYaw) {
      data.yawOffset = targetYaw
      data.hasYaw = true
    } else if (!WALK_FIRST && !aligned && !locked && !SIMULATED && yawRate < STILL_ENOUGH) {
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

      /*
       * Same fix, put to a second use: how far the viewer has moved since the
       * session began, in both frames at once.
       */
      if (!walkOrigin) {
        walkOrigin = { lat: fix.lat, lon: fix.lon, camX: camera.x, camZ: camera.z }
      } else if (!aligned) {
        const walked = toLocalMetres(walkOrigin, fix)
        const overGround = Math.hypot(walked.east, walked.north)
        const dx = camera.x - walkOrigin.camX
        const dz = camera.z - walkOrigin.camZ
        const throughSlam = Math.hypot(dx, dz)

        /*
         * Long enough to out-measure the fix's own error, and agreeing with
         * what the tracker saw. A GPS jump with no matching movement in SLAM
         * is noise, and would otherwise be read as a walk in some direction.
         */
        walkedNow = overGround
        const needed = Math.max(WALK_MIN, 2 * fix.accuracy)
        const agree = throughSlam > overGround * 0.5 && throughSlam < overGround * 2

        if (overGround >= needed && agree && overGround > walkBaseline * 1.15) {
          walkBaseline = overGround
          walkYaw = Math.atan2(walked.east, walked.north) - Math.atan2(dx, -dz)
          data.yawOffset = walkYaw
          data.hasYaw = true
          locked = true
        }
      }

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
