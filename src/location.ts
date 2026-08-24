/**
 * ── WHERE THE MODEL GOES ──────────────────────────────────────────────────
 *
 * Mirrors tccc-ar-test/src/location.js, value for value, so the two projects
 * behave identically out of the box.
 *
 * To get coordinates: open Google Maps, right-click the exact spot, and click
 * the "lat, lon" pair at the top of the menu to copy it. Decimal degrees,
 * north and east positive — west of Greenwich is negative, which is most of
 * the UK. Six decimals is about 10 cm, finer than GPS can resolve.
 */
export const INSTALLATION = {
  // Set from the map picker: on the Thames, with the run following the river
  // east on a bearing of 114.5°.
  label: 'Set me',
  lat: 51.5104797,
  lon: -0.0900796,
  /**
   * Metres above the viewer's feet. Leave at 0 for something standing on the
   * ground with you; raise it to put the model on a roof or a plinth.
   */
  elevation: 0,
}

/**
 * 'relative' ignores INSTALLATION and drops the model a fixed distance from
 * wherever you happen to be standing, so the experience works in any car park.
 * 'fixed' pins it to INSTALLATION, which is what you deploy.
 *
 * Either can be forced per-visit with ?mode=fixed or ?mode=relative.
 */
export const DEFAULT_MODE = 'fixed'

/**
 * Lock the placement for production.
 *
 * Every setting here is overridable from the query string, which is what makes
 * it tunable in the field — and also means anyone can drag the aircraft
 * somewhere else by editing the URL. With this true, the parameters that
 * decide *where* the experience is (lat, lon, mode, heading, elev) are
 * ignored, and only the harmless presentation ones still work.
 */
export const LOCKED = false

/**
 * ── THE PRINTED QR ────────────────────────────────────────────────────────
 *
 * Ignore the numbers baked into a link, and fly what is in this file and in
 * .expanse.json instead.
 *
 * A QR that has been printed cannot be reissued. The one on the artwork
 * carries the anchor, heading, length, turn, altitude, speed and size that
 * were current the day it went to print, and every one of those is now stale —
 * but it is on paper, in people's hands, and it is the link the public will
 * scan. With this true, all of it is discarded on arrival and the experience
 * is whatever the code says it is, which is the only copy that can still be
 * changed.
 *
 * The map picker's own links carry `link=1` and are honoured as before, so the
 * authoring tool keeps working while the printed code is overridden. That is
 * also the limit of it: anyone who notices the parameter can re-enable the
 * override on their own link. It exists to retire a stale print, not to defend
 * against anyone, and LOCKED above is the one that admits no exceptions —
 * including from the picker.
 */
export const IGNORE_LINK_SETTINGS = true

/**
 * Which way the aircraft beats back and forth.
 *
 * A true compass bearing, held regardless of where you stand. The Thames runs
 * roughly WSW-ENE through central London, but its bearing changes sharply
 * along its length, so measure it at the spot you're using: drop two Google
 * Maps pins along the stretch you want and take the bearing between them.
 */
export const FLIGHT_HEADING = 114.5

/**
 * Degrees added to every compass reading, overridable with `?north=`.
 *
 * A property of the *device*, not of the site — which is why it defaults to
 * zero and why nothing in the scene carries it. But a magnetometer that reads
 * a quadrant out rotates the whole content frame, and on the ground that looks
 * exactly like the run having been drawn across the river instead of along it.
 * When a site is only ever visited with one phone, or a platform turns out to
 * be systematically wrong, the correction has to be shippable rather than
 * retyped into the address bar. Find it on site with `?north=`, then paste it
 * here from the map picker's snippet.
 */
export const COMPASS_OFFSET = 0

/** Relative-mode placement: how far away, and on what compass bearing. */
export const RELATIVE_PLACEMENT = {
  distance: 20, // metres
  bearing: 0, // degrees from true north; 0 = due north, 90 = east
}

/**
 * The circuit as flown at this installation, and how big the aircraft is on it.
 *
 *   length  metres of straight leg
 *   size    overall length of the whole assembly — aircraft, tow line and
 *           banner — in metres
 *
 * turnRadius 55 m is easier on the eye than the 20 m it was, but still tight
 * for this aircraft: at 60 m/s a real 45° bank wants about 367 m, so the bank
 * still clamps and the turn is quick. It also leaves the two legs 110 m apart
 * while the assembly is 400 m long, so the banner is still outbound as the
 * nose comes back and the model passes through itself at each end. Only the
 * turns are affected — the long straight legs read fine.
 */
export const FLIGHT = {
  length: 2475,
  turnRadius: 55,
  altitude: 50,
  speed: 60,
  size: 400,
}

/**
 * Where the simulated viewer stands, as a bearing from the anchor. Standing
 * due south of a run that happens to lie north-south means watching it fly
 * straight at you; perpendicular shows the whole sweep.
 */
export const VIEW_FROM = 180
