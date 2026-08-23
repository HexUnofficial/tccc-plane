import * as ecs from '@8thwall/ecs'

/**
 * Turn off double-sided rendering wherever the geometry is solid.
 *
 * Ported from tccc-ar-test's `cullBackfacesOnSolids`. The export marks every
 * material doubleSided, so interior faces are drawn as well as exterior ones.
 * On the banner that is not merely wasteful but visibly wrong: it is a
 * two-layer sheet whose two faces carry separate UVs — one copy of the
 * lettering per side — with the layers a few millimetres apart once scaled.
 * The inside of the far layer therefore draws over the outside of the near
 * one and its reversed lettering bleeds through, so the banner reads forwards
 * and backwards at once and neither is legible.
 *
 * The original did this after its own GLTFLoader call. Here the engine owns
 * loading, so we hook GLTF_MODEL_LOADED and walk the three.js group it hands
 * back. `side` is set numerically (0 = FrontSide) because three is the
 * engine's bundled copy, not a dependency we can import constants from.
 */
const FRONT_SIDE = 0

type Geometry = { getAttribute?: (name: string) => { count: number; getX(i: number): number;
  getY(i: number): number; getZ(i: number): number } | undefined }
type Material = { side?: number; needsUpdate?: boolean }
type Mesh = { isMesh?: boolean; geometry?: Geometry; material?: Material | Material[] }

/**
 * Does this geometry enclose a volume, or is it a one-sided sheet?
 *
 * Summing the vertex normals of a closed shell very nearly cancels, because
 * every outward face is opposed by one pointing the other way. On an open
 * sheet they all agree instead, so the sum keeps close to its full length.
 * Measured on this aircraft: the banner comes out at 0.13 and the three
 * genuinely one-sided parts at 0.98 to 1.00, so 0.6 sits in open space.
 *
 * Decided from the geometry rather than from material or mesh names
 * deliberately: the model is redelivered as the design changes, and a rename
 * would silently switch a name-matched fix back off, with the only symptom
 * being unreadable lettering.
 */
function enclosesVolume(geometry?: Geometry): boolean {
  const normal = geometry?.getAttribute?.('normal')
  if (!normal || normal.count === 0) return false

  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < normal.count; i += 1) {
    x += normal.getX(i)
    y += normal.getY(i)
    z += normal.getZ(i)
  }
  return Math.hypot(x, y, z) / normal.count < 0.6
}

function cullBackfacesOnSolids(root: { traverse: (fn: (child: Mesh) => void) => void }) {
  const sheetMaterials = new Set<Material>()
  const solidMaterials = new Set<Material>()

  root.traverse((child) => {
    if (!child.isMesh) return
    const solid = enclosesVolume(child.geometry)
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (material) (solid ? solidMaterials : sheetMaterials).add(material)
    }
  })

  let culled = 0
  for (const material of solidMaterials) {
    // A material shared between a solid and a sheet stays double-sided —
    // culling it would make the sheet vanish from one side, which is the one
    // way this could make things worse.
    if (sheetMaterials.has(material)) continue
    material.side = FRONT_SIDE
    material.needsUpdate = true
    culled += 1
  }
  return { culled, sheets: sheetMaterials.size }
}

ecs.registerBehavior((world) => {
  const anyWorld = world as unknown as { __bannerFixWired?: boolean }
  if (anyWorld.__bannerFixWired) return
  anyWorld.__bannerFixWired = true

  world.events.addListener(world.events.globalId, ecs.events.GLTF_MODEL_LOADED, (event) => {
    const model = (event.data as { model?: { traverse?: unknown } } | undefined)?.model
    if (!model || typeof model.traverse !== 'function') return
    cullBackfacesOnSolids(model as { traverse: (fn: (child: Mesh) => void) => void })
  })
})
