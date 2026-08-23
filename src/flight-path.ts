import * as ecs from '@8thwall/ecs'

const { vec3, quat } = ecs.math

const TAU = Math.PI * 2
const GRAVITY = 9.81
const WORLD_UP = vec3.up()

type FlightPathOptions = {
  shape: string
  altitude: number
  maxBank: number // radians
  speed: number
  heading: number // compass degrees
  length: number // racetrack
  turnRadius: number // racetrack
  radius: number // eight, circle
  period: number // eight, circle
  rollTime: number
}

/**
 * A flight circuit around the anchor. Ported from tccc-ar-test/src/flight.js,
 * with three.js Vector3/Matrix4/Quaternion swapped for @8thwall/ecs's own
 * immutable vec3/quat math (the engine has no `three` package of its own to
 * import against, so this uses the vocabulary it exposes instead).
 *
 * The default shape is a racetrack: a long straight leg, a 180 at the end,
 * and a straight leg back. Aligned to a compass heading it reads as an
 * aircraft beating up and down a river, which a circle or figure-eight does
 * not — those visibly double back through the middle.
 *
 * Paths are parametrised by distance travelled rather than by angle, so speed
 * is constant everywhere and is set in m/s rather than falling out of the
 * geometry.
 */
export function createFlightPath({
  shape, altitude, maxBank, speed, heading,
  length, turnRadius,
  radius, period,
  rollTime,
}: FlightPathOptions) {
  // Rotate the whole circuit onto its compass heading. North = -Z, east = +X
  // (matching tccc-ar-test's LocAR world), and the path is authored running
  // along +X, so a bearing of θ needs a yaw of 90° - θ.
  const headingYaw = quat.yRadians(((90 - heading) * Math.PI) / 180)

  const straight = Math.max(length, 0)
  const turnArc = Math.PI * turnRadius
  const perimeter = 2 * straight + 2 * turnArc

  /** Racetrack, parametrised by distance travelled around it. */
  function racetrackAt(distance: number) {
    const half = straight / 2
    let d = ((distance % perimeter) + perimeter) % perimeter

    if (d < straight) return vec3.xyz(-half + d, altitude, turnRadius) // outbound leg
    d -= straight
    if (d < turnArc) {
      const a = d / turnRadius // 0..PI around the far end
      return vec3.xyz(half + turnRadius * Math.sin(a), altitude, turnRadius * Math.cos(a))
    }
    d -= turnArc
    if (d < straight) return vec3.xyz(half - d, altitude, -turnRadius) // return leg
    d -= straight
    const a = d / turnRadius // 0..PI around the near end
    return vec3.xyz(-half - turnRadius * Math.sin(a), altitude, -turnRadius * Math.cos(a))
  }

  function positionAt(t: number) {
    let p
    if (shape === 'racetrack') {
      p = racetrackAt(speed * t)
    } else {
      const angle = (TAU * t) / period
      p = shape === 'circle'
        ? vec3.xyz(radius * Math.cos(angle), altitude, radius * Math.sin(angle))
        // Lemniscate of Gerono — a self-crossing loop, kept for comparison.
        : vec3.xyz(radius * Math.cos(angle), altitude, radius * Math.sin(angle) * Math.cos(angle))
    }
    return headingYaw.timesVec(p)
  }

  // A racetrack's curvature jumps the instant the straight meets the turn.
  // Real aircraft take a moment to roll, so the bank is eased rather than
  // snapped.
  let bank = 0
  let lastTime: number | null = null

  return {
    positionAt,
    perimeter,
    lapTime: shape === 'racetrack' ? perimeter / speed : period,

    /** Place and orient `entity` for time `t` (seconds since the flight began). */
    apply(entity: ecs.Entity, t: number) {
      const h = 0.02
      const sample = positionAt(t)
      const before = positionAt(t - h)
      const after = positionAt(t + h)

      const velocity = after.minus(before).scale(1 / (2 * h))
      const acceleration = after.plus(before).plus(sample.scale(-2)).scale(1 / (h * h))

      entity.setLocalPosition(sample)

      const rate = velocity.length()
      if (rate < 1e-6) return
      const forward = velocity.scale(1 / rate)

      // Bank into the turn: the sideways component of acceleration balanced
      // against gravity is the angle a real aircraft would hold.
      const right = forward.cross(WORLD_UP).normalize()
      const lateral = acceleration.minus(forward.scale(acceleration.dot(forward)))
      const target = Math.max(-maxBank, Math.min(maxBank, Math.atan2(lateral.dot(right), GRAVITY)))

      const dt = lastTime === null ? 0 : Math.min(Math.abs(t - lastTime), 0.25)
      lastTime = t
      bank = rollTime > 0 && dt > 0
        ? bank + (target - bank) * (1 - Math.exp(-dt / rollTime))
        : target

      // Orient so the entity's forward axis points down the velocity vector,
      // then roll about that same (now-local) axis.
      const orientation = quat.lookAt(vec3.zero(), forward, WORLD_UP)
      const roll = quat.axisAngle(vec3.xyz(0, 0, bank))
      entity.set(ecs.Quaternion, orientation.times(roll))
    },
  }
}
