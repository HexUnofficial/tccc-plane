import * as ecs from '@8thwall/ecs'

/**
 * A minimal telemetry line, attached to a UI text entity. Set `target` (in
 * the Inspector, or in .expanse.json) to the entity being flown — here, the
 * "Motion" entity driven by flight-motion.ts.
 *
 * This is a deliberately small slice of tccc-ar-test's hud.js: that version's
 * screen-space "which way to look" arrow leaned on three.js's Frustum/Box3
 * and the raw camera projection matrix, neither of which this port had a
 * verified equivalent for at ECS's current documented surface. Range and
 * elapsed flight time are the two numbers worth having on screen to confirm
 * the circuit is actually running and roughly how far away it is.
 */
export const FlightHud = ecs.registerComponent({
  name: 'flight-hud',
  schema: {
    target: 'eid',
  },
  tick: (w, { eid, schema }) => {
    const targetEid = schema.target
    if (!targetEid) return

    const cameraEid = w.camera.getActiveEid()
    const modelPosition = w.transform.getWorldPosition(targetEid)
    const cameraPosition = w.transform.getWorldPosition(cameraEid)
    const range = modelPosition.distanceTo(cameraPosition)
    const text = range < 1000 ? `${range.toFixed(0)} m` : `${(range / 1000).toFixed(2)} km`

    ecs.Ui.mutate(w, eid, (cursor) => {
      cursor.text = `Range to aircraft: ${text}`
      return false
    })
  },
})
