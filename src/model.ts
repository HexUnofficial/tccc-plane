/**
 * The aircraft GLB's own dimensions, and what has to be done to it to make it
 * a given number of real-world metres long.
 *
 * tccc-ar-test did this at load time in model.js, measuring the loaded scene
 * with three.js. The engine owns loading here, so the measurement is done
 * ahead of time instead — these are `getBounds()` from @gltf-transform/core on
 * the exact GLB that ships in src/assets, and the resulting transform is baked
 * into src/.expanse.json for the default size. This module exists so that the
 * `?size=` override and the HUD's on-screen-size maths agree with that bake
 * instead of each carrying their own copy of the numbers.
 */
import { placedNum } from './config'

const GLB = {
  size: [188.30322949797846, 89.36243069658263, 653.8289012796758],
  centre: [-0.0000028058725547452923, -5.2316101974445495, -165.87218571270114],
}

/** Normalised along the longest axis: you think about an aeroplane in span. */
const LONGEST = Math.max(...GLB.size)

/**
 * Overall length of the whole assembly — aircraft, tow line and banner — in
 * metres, matching FLIGHT.size in location.ts and the scale baked into the
 * scene. Realistic would be about 30 m, which leaves the banner unreadable
 * from across a river; at a few hundred metres there is no nearby reference
 * to judge scale against, so the exaggeration costs little and the banner is
 * the entire point.
 */
export const DEFAULT_SIZE = 400

export function requestedSize(): number {
  // Through `placedNum`, so the size on a stale printed QR is discarded with
  // the rest of its numbers. See IGNORE_LINK_SETTINGS in location.ts.
  const size = placedNum('size', DEFAULT_SIZE)
  return size > 0 ? size : DEFAULT_SIZE
}

export const scaleFor = (size: number) => size / LONGEST

/** Recentres the model on its own middle, so it flies about its centre. */
export const offsetFor = (size: number) => {
  const s = scaleFor(size)
  return { x: -GLB.centre[0] * s, y: -GLB.centre[1] * s, z: -GLB.centre[2] * s }
}

/**
 * Half-extents of the assembly in Motion-local metres. The 180° nose yaw only
 * flips signs, so it leaves the box unchanged.
 */
export const halfExtentsFor = (size: number) => {
  const s = scaleFor(size)
  return { x: (GLB.size[0] * s) / 2, y: (GLB.size[1] * s) / 2, z: (GLB.size[2] * s) / 2 }
}
