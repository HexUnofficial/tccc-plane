import * as ecs from '@8thwall/ecs'
import { FlightMotion } from './flight-motion'

/**
 * Whether the aircraft is really in the scene — not merely on its way.
 *
 * Nothing is allowed through the gate until this is true, so a false positive
 * here is the whole failure it exists to prevent: someone in a live camera
 * feed, with an arrow pointing confidently at an aeroplane that is still
 * downloading. It is therefore written to be hard to satisfy by accident.
 *
 * Two independent signals, either of which is sufficient:
 *
 *   - a descendant that is a mesh *with vertices in it*. An empty Mesh, or a
 *     Group the loader put in place to hang the model on, does not count —
 *     which is the difference between "the entity exists" (true from the first
 *     frame, and what an isMesh check alone would have accepted) and "there is
 *     an aeroplane".
 *
 *   - GLTF_MODEL_LOADED. Kept as a second route because it is the engine's own
 *     word for it, but not relied on alone: a behavior only starts running
 *     once the world ticks, and the event may already have been dispatched by
 *     then — the same trap gate.ts documents for REALITY_READY. Registered on
 *     the first tick, so it catches every later model.
 */
const motionQuery = ecs.defineQuery([FlightMotion])

type Node = {
  isMesh?: boolean
  geometry?: { attributes?: { position?: { count?: number } } }
  traverse?: (visit: (child: Node) => void) => void
}

let ready = false
let listening = false

function hasGeometry(object: unknown): boolean {
  const root = object as Node | undefined
  if (typeof root?.traverse !== 'function') return false
  let found = false
  root.traverse((child) => {
    if (child.isMesh && (child.geometry?.attributes?.position?.count ?? 0) > 0) found = true
  })
  return found
}

export function modelIsInScene(world: ecs.World): boolean {
  if (ready) return true

  if (!listening) {
    listening = true
    world.events.addListener(world.events.globalId, ecs.events.GLTF_MODEL_LOADED, () => {
      ready = true
    })
  }

  const eids = motionQuery(world)
  if (eids.length === 0) return false
  // Latches: once true this whole function is a single boolean read.
  ready = hasGeometry(world.three.entityToObject.get(eids[0]))
  return ready
}
