import * as ecs from '@8thwall/ecs'
import { DEFAULT_SIZE, offsetFor, requestedSize, scaleFor } from './model'

/**
 * Applies `?size=` to the aircraft, in metres of overall assembly length.
 *
 * The scene already bakes the transform for the default size, so this does
 * nothing at all unless the parameter is present and different — it exists so
 * that the field-tuning knob tccc-ar-test had still works here, rather than
 * being a URL parameter that silently changes only the telemetry readout.
 *
 * Recentring has to move with the scale: the model is normalised about its own
 * middle, so a different scale needs a proportionally different offset, which
 * is why this sets Position as well as Scale.
 */
export const ModelScale = ecs.registerComponent({
  name: 'model-scale',
  add: (world, { eid }) => {
    const size = requestedSize()
    if (size === DEFAULT_SIZE) return

    const s = scaleFor(size)
    const offset = offsetFor(size)
    ecs.Scale.set(world, eid, { x: s, y: s, z: s })
    ecs.Position.set(world, eid, offset)
  },
})
