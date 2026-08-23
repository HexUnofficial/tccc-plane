/**
 * Great-circle helpers. All bearings are degrees clockwise from true north.
 *
 * Ported verbatim from tccc-ar-test/src/geo.js — pure math, no dependency on
 * three.js or the AR engine, so nothing about moving to 8th Wall changes it.
 */
const R = 6371008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

type LatLon = { lat: number; lon: number };

/** Distance in metres between two {lat, lon} points. */
export function distanceBetween(from: LatLon, to: LatLon): number {
  const dLat = rad(to.lat - from.lat);
  const dLon = rad(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial bearing from one {lat, lon} to another, in degrees 0-360. */
export function bearingBetween(from: LatLon, to: LatLon): number {
  const dLon = rad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(rad(to.lat));
  const x =
    Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) -
    Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The {lat, lon} you reach travelling `metres` along `bearing` from `from`. */
export function destination(from: LatLon, bearing: number, metres: number): LatLon {
  const d = metres / R;
  const b = rad(bearing);
  const lat1 = rad(from.lat);
  const lon1 = rad(from.lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: deg(lat2), lon: ((deg(lon2) + 540) % 360) - 180 };
}

/** Compass point label for a bearing, e.g. 200 -> "SSW". */
export function compassPoint(bearing: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round((bearing % 360) / 22.5) % 16];
}
