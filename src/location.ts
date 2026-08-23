/**
 * ── WHERE THE MODEL GOES ──────────────────────────────────────────────────
 *
 * Ported from tccc-ar-test/src/location.js. To get coordinates: open Google
 * Maps, right-click the exact spot, and click the "lat, lon" pair at the top
 * of the menu to copy it. Decimal degrees, north and east positive.
 */
export const INSTALLATION = {
  lat: 51.5104797,
  lon: -0.0900796,
};

/**
 * Which way the aircraft beats back and forth: a true compass bearing, held
 * regardless of where the viewer stands. Measure it by dropping two Google
 * Maps pins along the stretch of river you want and taking the bearing
 * between them.
 */
export const FLIGHT_HEADING = 114.5;

/**
 * The circuit as flown at this installation, and how big the aircraft is on
 * it. See tccc-ar-test/README.md for how these were tuned — turnRadius 55 m
 * is tight for a 400 m assembly at 60 m/s, which is deliberate: only the
 * turns are affected, the long straight legs read fine.
 */
export const FLIGHT = {
  length: 2475,
  turnRadius: 55,
  altitude: 50,
  speed: 60,
  size: 400,
};
