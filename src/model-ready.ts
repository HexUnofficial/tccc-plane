import * as ecs from '@8thwall/ecs'
import { FlightMotion } from './flight-motion'
import { num } from './config'

/**
 * Whether the aircraft has *finished* arriving — not merely started.
 *
 * Nothing gets through the gate until this is true, so a false positive here
 * is the whole failure it exists to prevent. Two earlier versions of this were
 * both too easy to satisfy:
 *
 *   - GLTF_MODEL_LOADED alone. A behavior only starts running once the world
 *     ticks, so on a warm cache the event can be dispatched before the
 *     listener exists and never be heard again — the trap gate.ts already
 *     documents for REALITY_READY.
 *
 *   - "a descendant is a mesh". True the moment the *first* of the model's 220
 *     meshes appears. They are Draco-compressed and decoded a piece at a time,
 *     so that is early, and it is the difference between an aeroplane and a
 *     wingtip.
 *
 * So the test is that the scene has *stopped changing*: count the meshes,
 * their vertices, and the textures that have actually decoded, and require the
 * total to hold still for a couple of seconds. While anything is still
 * streaming in the count moves and the clock restarts. That also covers what
 * "loaded" misses — geometry present but textures still decoding, which draws
 * an untextured aeroplane.
 */
const motionQuery = ecs.defineQuery([FlightMotion])

/** Seconds of nothing changing before the model counts as ready. */
const SETTLE_MS = num('ready', 2) * 1000

type Texture = { image?: { width?: number } }
type Material = { map?: Texture; emissiveMap?: Texture; normalMap?: Texture }
type Node = {
  isMesh?: boolean
  material?: Material | Material[]
  geometry?: { attributes?: { position?: { count?: number } } }
  traverse?: (visit: (child: Node) => void) => void
}

let ready = false
let listening = false
let loadedEvent = false
let signature = ''
let steadySince = 0

const decoded = (texture: Texture | undefined) => ((texture?.image?.width ?? 0) > 0 ? 1 : 0)

/** Meshes, vertices and decoded textures under `object`. */
function measure(object: unknown) {
  const root = object as Node | undefined
  let meshes = 0
  let vertices = 0
  let textures = 0
  if (typeof root?.traverse !== 'function') return { meshes, vertices, textures }
  root.traverse((child) => {
    if (!child.isMesh) return
    const count = child.geometry?.attributes?.position?.count ?? 0
    if (count === 0) return
    meshes += 1
    vertices += count
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      textures += decoded(material?.map) + decoded(material?.emissiveMap) + decoded(material?.normalMap)
    }
  })
  return { meshes, vertices, textures }
}

/**
 * How much of the model is in the scene, for a wait that has gone on long
 * enough to be worth explaining. Rises as the pieces decode, which is the
 * difference between a slow connection and a hung one.
 */
let parts = 0
export const modelParts = () => parts

export function modelIsInScene(world: ecs.World): boolean {
  if (ready) return true

  if (!listening) {
    listening = true
    world.events.addListener(world.events.globalId, ecs.events.GLTF_MODEL_LOADED, () => {
      loadedEvent = true
    })
  }

  const eids = motionQuery(world)
  if (eids.length === 0) return false

  const { meshes, vertices, textures } = measure(world.three.entityToObject.get(eids[0]))
  const now = world.time.elapsed
  parts = meshes

  // The engine's own word for it is one more input, not a shortcut: it still
  // has to hold still afterwards, which is the "and a few seconds more" that
  // lets the first frames of a heavy model get drawn before anyone sees them.
  const current = `${meshes}:${vertices}:${textures}:${loadedEvent}`
  if (current !== signature) {
    signature = current
    steadySince = now
    return false
  }

  if (meshes === 0) return false
  ready = now - steadySince >= SETTLE_MS
  return ready
}
