/**
 * The bearing a phone's camera points, from a device orientation event.
 *
 * ── Why this is not a one-liner ───────────────────────────────────────────
 * The obvious formula — `360 − alpha`, corrected by the screen angle — is
 * exact only for a phone held upright in portrait, and that is the assumption
 * that broke this project. The page is locked to portrait by the manifest and
 * asks for fullscreen, so `screen.orientation.angle` stays 0 when someone
 * turns the phone sideways to watch an aircraft fly along a river: the screen
 * correction contributes nothing while the device frame really has rotated 90°,
 * and the entire content frame comes out square to the run.
 *
 * tccc-ar-test never hit this because LocAR never reduced the sensor to a
 * bearing at all. It builds the camera's whole orientation from alpha, beta and
 * gamma and lets the pointing direction fall out of the quaternion, which is
 * what this does — the same composition three.js's DeviceOrientationControls
 * uses, worked through to the one component we need:
 *
 *     forward = Ry(α) · Rx(β) · Rz(−γ) · Rx(−90°) · (0, 0, −1)
 *
 * The screen angle is deliberately absent. It appears in the full formula as a
 * final rotation about the camera's own view axis, and a roll about the axis
 * you are looking down cannot change where you are looking. Rotating the phone
 * in your hands moves gamma, and gamma is already here.
 *
 * Pure arithmetic on purpose, with no imports: it is the piece that was wrong,
 * so it is the piece that has to be testable outside a browser.
 */
const RAD = Math.PI / 180

/**
 * @param alpha rotation about the vertical, degrees, anticlockwise from north
 * @param beta  front-to-back tilt, degrees; 90 is upright
 * @param gamma left-to-right roll, degrees; ±90 is on its side
 * @returns compass bearing of the rear camera, degrees clockwise from north
 */
export function azimuthFrom(alpha: number, beta: number, gamma: number): number {
  const sinA = Math.sin(alpha * RAD)
  const cosA = Math.cos(alpha * RAD)
  const sinB = Math.sin(beta * RAD)
  const sinG = Math.sin(gamma * RAD)
  const cosG = Math.cos(gamma * RAD)

  // The x and z of the forward vector after the composition above. Only the
  // horizontal components matter for a bearing, so the y term is dropped.
  const x = -sinG * cosA - cosG * sinB * sinA
  const z = sinG * sinA - cosG * sinB * cosA

  // North is −Z and east is +X, the same convention as circuit.ts and
  // gps-anchor.ts, so the bearing is atan2(east, north).
  return ((Math.atan2(x, -z) / RAD) + 360) % 360
}
