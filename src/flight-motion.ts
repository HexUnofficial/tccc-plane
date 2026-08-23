import * as ecs from '@8thwall/ecs'
import { createFlightPath } from './flight-path'
import { FLIGHT, FLIGHT_HEADING } from './location'

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
const params = new URLSearchParams(location.search)

const num = (key: string, fallback: number) => {
  const value = Number.parseFloat(params.get(key) ?? '')
  return Number.isFinite(value) ? value : fallback
}

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
      shape: params.get('path') ?? schema.shape,
      altitude: num('alt', schema.altitude),
      speed: num('speed', schema.speed),
      maxBank: degToRad(num('bank', schema.maxBank)),
      rollTime: num('rolltime', schema.rollTime),
      length: num('length', schema.length),
      turnRadius: num('turn', schema.turnRadius),
      radius: num('radius', schema.radius),
      period: num('period', schema.period),
      heading: num('heading', schema.heading),
    }))
  },
  tick: (w, { eid, data }) => {
    const path = paths.get(eid)
    if (!path) return
    path.apply(w.getEntity(eid), w.time.elapsed - data.startTime)
  },
  remove: (_w, { eid }) => {
    paths.delete(eid)
  },
})
