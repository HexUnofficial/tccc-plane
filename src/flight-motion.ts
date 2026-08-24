import * as ecs from '@8thwall/ecs'
import { createFlightPath } from './flight-path'
import { FLIGHT, FLIGHT_HEADING } from './location'
import { num, placed, placedNum } from './config'

/**
 * Drives the entity it's attached to along the flight circuit every frame.
 *
 * Attach this to the entity directly under the MapPoint anchor (see
 * .expanse.json — the "Motion" entity, parented to "Flight Anchor"). Its own
 * local position/rotation are in metres relative to that GPS-anchored point,
 * same division of labour as tccc-ar-test: the MapPoint (GPS + `useGPS`) owns
 * *where* the circuit is in the real world, this owns *what the aircraft is
 * doing* around that point.
 *
 * Every setting is also overridable from the URL query string, exactly as in
 * tccc-ar-test's config.js, so it can be retuned in the field without
 * republishing from Studio.
 */
/*
 * The circuit's shape and size come through `placed`/`placedNum`, so a stale
 * printed QR cannot fly the aircraft on last month's numbers — see
 * IGNORE_LINK_SETTINGS in location.ts. `bank` and `rolltime` stay on plain
 * `num`: they are handling qualities rather than placement, nothing on a
 * printed code sets them, and they are useful to tune from the address bar.
 */

const degToRad = (d: number) => (d * Math.PI) / 180

// Rich per-entity state (the flight path closure, with its own eased-bank
// memory) lives here rather than in the numeric ECS schema/data fields,
// which only hold primitives.
const paths = new Map<ecs.Eid, ReturnType<typeof createFlightPath>>()

export const FlightMotion = ecs.registerComponent({
  name: 'flight-motion',
  schema: {
    shape: 'string',
    length: 'f32',
    turnRadius: 'f32',
    speed: 'f32',
    altitude: 'f32',
    maxBank: 'f32',
    rollTime: 'f32',
    radius: 'f32',
    period: 'f32',
    heading: 'f32',
  },
  schemaDefaults: {
    shape: 'racetrack',
    length: FLIGHT.length,
    turnRadius: FLIGHT.turnRadius,
    speed: FLIGHT.speed,
    altitude: FLIGHT.altitude,
    maxBank: 45,
    rollTime: 0.8,
    radius: 30,
    period: 16,
    heading: FLIGHT_HEADING,
  },
  data: {
    startTime: 'f64',
  },
  add: (w, { eid, schema, data }) => {
    data.startTime = w.time.elapsed
    paths.set(eid, createFlightPath({
      shape: placed('path') ?? schema.shape,
      altitude: placedNum('alt', schema.altitude),
      speed: placedNum('speed', schema.speed),
      maxBank: degToRad(num('bank', schema.maxBank)),
      rollTime: num('rolltime', schema.rollTime),
      length: placedNum('length', schema.length),
      turnRadius: placedNum('turn', schema.turnRadius),
      radius: placedNum('radius', schema.radius),
      period: placedNum('period', schema.period),
      heading: placedNum('heading', schema.heading),
    }))
  },
  tick: (w, { eid, data }) => {
    const path = paths.get(eid)
    if (!path) return
    /*
     * Seconds. `time.elapsed` is milliseconds — as the /1000 in hud.ts and
     * gps-anchor.ts and the 6000 ms gate timeout all attest — and the circuit
     * is parametrised by distance travelled at `speed` metres per *second*.
     *
     * Handing it milliseconds flew the aircraft a thousand times too fast: at
     * the deployed 60 m/s that is 60 km/s, about eleven laps of the Thames
     * circuit every second. It is not that the model was missing, it was
     * somewhere else entirely on each frame — which is what the arrow was
     * chasing, and why shortening the run and slowing the speed barely helped.
     * tccc-ar-test accumulated three.js's clock.getDelta(), already in seconds,
     * so the units were only ever wrong on this side of the port.
     */
    path.apply(w.getEntity(eid), (w.time.elapsed - data.startTime) / 1000)
  },
  remove: (_w, { eid }) => {
    paths.delete(eid)
  },
})
