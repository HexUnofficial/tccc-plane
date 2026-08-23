/**
 * The circuit's *shape*, as plain arithmetic on plain objects.
 *
 * This is the half of flight-path.ts that has no engine in it: where the
 * aircraft is at time t, and nothing about how it is oriented, banked or
 * attached to an entity. It is split out because two very different callers
 * need the same answer:
 *
 *   - flight-path.ts, at runtime in the AR page, where `@8thwall/ecs` is
 *     available as the `window.ecs` global the runtime script tag installs;
 *   - the map picker in setup/, which is an ordinary web page with no 8th Wall
 *     runtime on it at all. Importing flight-path.ts there would pull in
 *     `@8thwall/ecs`, which webpack has configured as `externals:
 *     {'@8thwall/ecs': 'window.ecs'}` — so the import would resolve to
 *     `undefined` and the picker would die on `ecs.math` at load.
 *
 * Keeping it here means the outline the picker draws is sampled from the same
 * arithmetic the aircraft actually flies, rather than a second implementation
 * that can drift from it.
 *
 * Ported from tccc-ar-test/src/flight.js.
 */

const TAU = Math.PI * 2

export type Point3 = { x: number; y: number; z: number }

export type CircuitOptions = {
  shape: string
  altitude: number
  speed: number
  /** Compass degrees clockwise from true north. */
  heading: number
  length: number // racetrack
  turnRadius: number // racetrack
  radius: number // eight, circle
  period: number // eight, circle
}

/**
 * Right-handed rotation about +Y, i.e. the standard Ry(θ) matrix.
 *
 * This is deliberately the same operation as `ecs.math.quat.yRadians(θ)
 * .timesVec(p)`, which is what flight-path.ts used before the split — see the
 * derivation in gps-anchor.ts: yRadians(θ) turns a direction at compass angle
 * a into one at a − θ, and with east = +X and north = −Z that is exactly this
 * matrix. Written out in longhand so the setup page can use it without the
 * engine, and used by flight-path.ts too so there is only ever one of it.
 */
export function rotateY(p: Point3, radians: number): Point3 {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: p.x * cos + p.z * sin, y: p.y, z: -p.x * sin + p.z * cos }
}

/**
 * A closed circuit, parametrised by *distance travelled* rather than by angle,
 * so speed is constant everywhere and is set in m/s rather than falling out of
 * the geometry.
 *
 * The default shape is a racetrack: a long straight leg, a 180 at the end, and
 * a straight leg back. Aligned to a compass heading it reads as an aircraft
 * beating up and down a river, which a circle or figure-eight does not — those
 * visibly double back through the middle.
 */
export function createCircuit({
  shape, altitude, speed, heading,
  length, turnRadius,
  radius, period,
}: CircuitOptions) {
  // Rotate the whole circuit onto its compass heading. North = −Z, east = +X
  // (matching tccc-ar-test's LocAR world), and the path is authored running
  // along +X, so a bearing of θ needs a yaw of 90° − θ.
  const headingYaw = ((90 - heading) * Math.PI) / 180

  const straight = Math.max(length, 0)
  const turnArc = Math.PI * turnRadius
  const perimeter = 2 * straight + 2 * turnArc

  /** Racetrack, parametrised by distance travelled around it. */
  function racetrackAt(distance: number): Point3 {
    const half = straight / 2
    let d = ((distance % perimeter) + perimeter) % perimeter

    if (d < straight) return { x: -half + d, y: altitude, z: turnRadius } // outbound leg
    d -= straight
    if (d < turnArc) {
      const a = d / turnRadius // 0..PI around the far end
      return {
        x: half + turnRadius * Math.sin(a),
        y: altitude,
        z: turnRadius * Math.cos(a),
      }
    }
    d -= turnArc
    if (d < straight) return { x: half - d, y: altitude, z: -turnRadius } // return leg
    d -= straight
    const a = d / turnRadius // 0..PI around the near end
    return {
      x: -half - turnRadius * Math.sin(a),
      y: altitude,
      z: -turnRadius * Math.cos(a),
    }
  }

  /** Local metres relative to the anchor at time `t` seconds. */
  function positionAt(t: number): Point3 {
    let p: Point3
    if (shape === 'racetrack') {
      p = racetrackAt(speed * t)
    } else {
      const angle = (TAU * t) / period
      p = shape === 'circle'
        ? { x: radius * Math.cos(angle), y: altitude, z: radius * Math.sin(angle) }
        // Lemniscate of Gerono — a self-crossing loop, kept for comparison.
        : {
          x: radius * Math.cos(angle),
          y: altitude,
          z: radius * Math.sin(angle) * Math.cos(angle),
        }
    }
    return rotateY(p, headingYaw)
  }

  return {
    positionAt,
    perimeter,
    lapTime: shape === 'racetrack' ? perimeter / speed : period,
  }
}
