import * as ecs from '@8thwall/ecs'
import { createCircuit, CircuitOptions } from './circuit'

const { vec3, quat, mat4 } = ecs.math

const GRAVITY = 9.81
const WORLD_UP = vec3.up()

type FlightPathOptions = CircuitOptions & {
  maxBank: number // radians
  rollTime: number
}

/**
 * A flight circuit around the anchor. Ported from tccc-ar-test/src/flight.js,
 * with three.js Vector3/Matrix4/Quaternion swapped for @8thwall/ecs's own
 * immutable vec3/quat math (the engine has no `three` package of its own to
 * import against, so this uses the vocabulary it exposes instead).
 *
 * The *shape* of the circuit lives in circuit.ts, which has no engine import
 * in it, so the map picker in setup/ can sample the same arithmetic without a
 * runtime to give it `window.ecs`. What is left here is everything that needs
 * the engine: orientation, bank, and placing an entity.
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
  const circuit = createCircuit({
    shape, altitude, speed, heading, length, turnRadius, radius, period,
  })

  const { perimeter, lapTime } = circuit

  function positionAt(t: number) {
    const p = circuit.positionAt(t)
    return vec3.xyz(p.x, p.y, p.z)
  }

  // A racetrack's curvature jumps the instant the straight meets the turn.
  // Real aircraft take a moment to roll, so the bank is eased rather than
  // snapped.
  let bank = 0
  let lastTime: number | null = null

  return {
    positionAt,
    perimeter,
    lapTime,

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

      /*
       * Build the orientation basis by hand rather than with quat.lookAt.
       *
       * ECS's lookAt aligns local +Z with the target direction, where three.js
       * aligns local −Z, and the two libraries also differ in how the roll
       * then composes. Reproducing tccc-ar-test's basis exactly — columns
       * [right, up, −forward], via a row-major matrix decomposed to a
       * quaternion — keeps the bank direction provably identical to the
       * original instead of resting on a sign I'd have to re-derive. It also
       * means the model keeps the same noseOffset of 180° it already had.
       */
      const zAxis = forward.scale(-1)
      const basisRight = WORLD_UP.cross(zAxis).normalize()
      const up = zAxis.cross(basisRight)
      const orientation = mat4.i().makeRows([
        [basisRight.x, up.x, zAxis.x, 0],
        [basisRight.y, up.y, zAxis.y, 0],
        [basisRight.z, up.z, zAxis.z, 0],
        [0, 0, 0, 1],
      ]).decomposeR()

      /*
       * Then roll about the nose axis.
       *
       * Local +Z is the *tail* axis, not the nose: the basis above puts
       * −forward on +Z, so that the model's own +Z nose comes back round to
       * the direction of travel via the 180° Yaw node in the scene graph. A
       * right-handed roll of θ about local +Z is therefore a roll of −θ about
       * the nose, and `bank` is a bank angle about the nose — positive being
       * right wing up, out of the atan2 against gravity below.
       *
       * Rolling by +bank here banked the aircraft *out* of every turn: it
       * flew the racetrack's left-hand turns with the right wing dropped.
       */
      const roll = quat.axisAngle(vec3.xyz(0, 0, -bank))
      entity.set(ecs.Quaternion, orientation.times(roll))
    },
  }
}
