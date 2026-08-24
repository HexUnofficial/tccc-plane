import * as ecs from '@8thwall/ecs'
import { requestCompassPermission } from './compass'
import { modelIsInScene } from './model-ready'

/**
 * The branded splash, and the single tap that gets us into AR.
 *
 * Ported from tccc-ar-test's `#gate`. It is not merely decoration: iOS 13+
 * refuses `deviceorientation` events until an explicit grant, and that request
 * has to happen inside a user gesture. The Start button is that gesture, so
 * the compass permission is asked for here rather than off any stray tap.
 *
 * Note this is a different thing from 8th Wall's own LandingPage (configured
 * in app.js), which is the fallback shown to devices that *cannot* run WebAR
 * at all — a QR code to get you onto a phone. Both are branded; only this one
 * is seen by someone who is about to have the experience.
 */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

/** Android honours this. iPhone Safari has no Fullscreen API at all. */
function requestFullscreen() {
  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void>
  }
  const request = root.requestFullscreen ?? root.webkitRequestFullscreen
  if (!request) return
  // Deliberately not awaited: on iOS an await here would spend the user
  // gesture that the motion-permission prompt needs next.
  Promise.resolve(request.call(root, { navigationUI: 'hide' })).catch(() => {
    // Refused by policy or user setting — the experience still works.
  })
}

/**
 * How long before the wait is worth explaining rather than just enduring.
 *
 * Not a timeout: nobody is let through until the aircraft is here. Starting
 * without it puts someone in a live camera feed with an arrow pointing at an
 * empty sky, which reads as broken AR — and it is the aircraft they came for,
 * so there is nothing to be early for. The GLB is a ten megabyte download with
 * nine megabytes of texture in it, which on mobile data at a riverbank is a
 * genuine wait, so say that instead of appearing to hang.
 */
const SLOW_MS = 8000

let wired = false
let unlocked = false

function wire(world: ecs.World) {
  if (wired) return
  wired = true

  const gate = el('gate')
  const button = el<HTMLButtonElement>('gate-start')
  const message = el('gate-message')
  if (!gate || !button || !message) return

  button.addEventListener('click', () => {
    button.disabled = true
    requestFullscreen()
    void requestCompassPermission().then((granted) => {
      if (!granted) {
        // Not fatal on Android, and on iOS the content simply will not be
        // aimed correctly — better to say so than to show empty sky.
        message.textContent =
          'Motion access was denied. Enable it in Settings → Safari, then reload.'
      }
    })
    gate.hidden = true
  })
}

/**
 * Readiness is polled rather than driven purely by events.
 *
 * Behaviors only start running once the world ticks, and the world only ticks
 * once the camera pipeline is up — by which point REALITY_READY may already
 * have been dispatched. A listener registered here would miss it and strand
 * the button disabled. That the behavior is running at all *is* the signal
 * that reality is ready, so the only thing left to wait on is the model —
 * which is asked of the scene graph rather than of an event, for exactly the
 * same reason (see model-ready.ts).
 */
ecs.registerBehavior((world) => {
  wire(world)
  if (unlocked) return

  const button = el<HTMLButtonElement>('gate-start')
  const message = el('gate-message')
  if (!button || !message) return

  if (!modelIsInScene(world)) {
    message.textContent = world.time.elapsed > SLOW_MS
      ? 'Still loading the aircraft — it is a large model.'
      : 'Loading the aircraft…'
    return
  }

  unlocked = true
  message.textContent = 'Ready'
  button.disabled = false
})
