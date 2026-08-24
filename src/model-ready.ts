import * as ecs from '@8thwall/ecs'
import { FlightMotion } from './flight-motion'

/**
 * Whether the aircraft is actually in the scene, latched once it is.
 *
 * Read from the scene graph rather than from GLTF_MODEL_LOADED, for the reason
 * gate.ts already documents about REALITY_READY: a behavior only starts running
 * once the world ticks, by which point the event may already have been
 * dispatched, and a listener registered then would miss it and wait forever.
 * Meshes under the entity are the thing itself rather than a report of it.
 *
 * Two callers need the same answer. The gate holds the Start button until the
 * model is here, so nobody is shown an empty sky; the HUD holds the arrow, so
 * it never points with total confidence at an aeroplane that is still coming
 * down the wire.
 */
const motionQuery = ecs.defineQuery([FlightMotion])

type Traversable = { traverse: (visit: (child: { isMesh?: boolean }) => void) => void }

let ready = false

function hasMesh(object: unknown): boolean {
  const node = object as Traversable | undefined
  if (!node || typeof node.traverse !== 'function') return false
  let found = false
  // Stops mattering after the first frame that finds one — `ready` latches and
  // this is never called again.
  node.traverse((child) => {
    if (child.isMesh) found = true
  })
  return found
}

export function modelIsInScene(world: ecs.World): boolean {
  if (ready) return true
  const eids = motionQuery(world)
  if (eids.length === 0) return false
  ready = hasMesh(world.three.entityToObject.get(eids[0]))
  return ready
}
