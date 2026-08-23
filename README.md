# tccc-plane

GPS-anchored AR on **8th Wall Studio**: a banner-towing aircraft flies a fixed
racetrack circuit over a real-world coordinate, viewed through the phone's
camera. This is a port of the LocAR.js/three.js project in `tccc-ar-test`,
rebuilt on 8th Wall's ECS engine.

## What had to change, and why

`tccc-ar-test` gets its GPS anchoring from [LocAR.js](https://github.com/AR-js-org/locar.js),
which owns the camera, reads the GPS and compass, and holds content at a
latitude/longitude. 8th Wall has no equivalent in this runtime, so the port is
not a swap of one library for another — the anchoring is reimplemented here.

**The geospatial components in the docs are not in this package.** 8th Wall
documents `Map`, `MapPoint` and `GpsPointer` components that anchor content to
a latitude/longitude, and they appear in `@8thwall/ecs`'s TypeScript
declarations (`index.d.ts`) — but they are **not registered in the runtime**.
`ecs.listAttributes()` on a running page does not list them, and the strings do
not appear in `dist/runtime.js`. They belong to **Niantic Maps for Web**, part
of the hosted 8th Wall Studio product, not the open-source `@8thwall/ecs` npm
runtime this project builds against.

So [src/gps-anchor.ts](src/gps-anchor.ts) does the georeferencing by hand.

### How the anchoring works

8th Wall's SLAM tracking gives precise *relative* pose, but its world frame
starts at an arbitrary yaw with its origin wherever the session began. Two
corrections turn that into a georeferenced frame:

- **Heading.** The compass says the camera faces true bearing β; SLAM says it
  faces yaw ψ in its own frame. Rotating the anchor entity by (β − ψ) makes its
  local −Z point at true north and +X at east. That difference should be a
  *constant*, so it is heavily smoothed — the job is to estimate one fixed
  offset out of a noisy compass, not to track a moving value.
- **Position.** The GPS fix gives the offset in metres from viewer to
  installation. Placing the anchor at the camera's SLAM position plus that
  offset, rotated into the SLAM frame, puts it in the right place wherever the
  session started.

Between fixes, SLAM carries the motion. This is the one respect in which the
port should feel *better* than the original: `tccc-ar-test` had to ease between
GPS fixes to stop the scene lurching (see its README on `smooth=1.2`), whereas
here the tracker supplies genuinely continuous movement and GPS only corrects
the absolute position.

### Conventions that differ from three.js

Three were verified empirically against the running runtime rather than
assumed, because each would have failed silently:

| | three.js | `@8thwall/ecs` |
|---|---|---|
| `lookAt` forward axis | −Z | **+Z** |
| `yRadians(θ)` on a compass bearing | — | maps bearing `a` to `a − θ` |
| `mat4.makeRows` row layout | `makeBasis` columns | **same layout** |

Because of the first two, [src/flight-path.ts](src/flight-path.ts) builds its
orientation basis by hand — columns `[right, up, −forward]` via `makeRows` then
`decomposeR` — reproducing the original's basis exactly instead of resting on a
roll sign that would have to be re-derived. That also means the model keeps the
same 180° nose offset it already had (the GLB's propeller and headlight sit at
maximum +Z, the banner at −Z, so the nose points +Z).

## Files

| | |
|---|---|
| [src/gps-anchor.ts](src/gps-anchor.ts) | Holds an entity at a lat/lon; fuses GPS and compass into the SLAM frame |
| [src/gps.ts](src/gps.ts) | Geolocation watch, accuracy rejection, fix averaging, tangent-plane projection |
| [src/compass.ts](src/compass.ts) | True-north heading, including the iOS permission gesture |
| [src/flight-path.ts](src/flight-path.ts) | The racetrack circuit — ported from `tccc-ar-test/src/flight.js` |
| [src/flight-motion.ts](src/flight-motion.ts) | Component driving an entity along that circuit each tick |
| [src/flight-hud.ts](src/flight-hud.ts) | Range readout |
| [src/location.ts](src/location.ts) | **Where the installation is, and how it flies** |
| [src/geo.ts](src/geo.ts) | Great-circle helpers, ported verbatim |

The scene graph (`src/.expanse.json`) nests them the same way the original did,
each level owning exactly one concern:

```
GPS Anchor   gps-anchor      pinned to the real-world lat/lon
└ Motion     flight-motion   flies the circuit, in metres around the anchor
  └ Yaw                      180° nose correction
    └ Aircraft               the GLB, scaled to 400 m
```

The aircraft's scale and recentring are **baked into the scene transform**
rather than computed at load as they were in `tccc-ar-test/src/model.js`. The
numbers come from the same GLB measured with `gltf-transform`'s `getBounds()`:
longest axis 653.83 units → scale 0.61178 for a 400 m assembly.

## Configuring the location

Edit [src/location.ts](src/location.ts), then mirror the values into the
`gps-anchor` and `flight-motion` parameters in `src/.expanse.json` (or edit them
in Studio's Inspector, which is the same thing).

```ts
export const INSTALLATION = { lat: 51.5104797, lon: -0.0900796 }
export const FLIGHT_HEADING = 114.5   // true bearing, down the river
export const FLIGHT = { length: 2475, turnRadius: 55, altitude: 50, speed: 60, size: 400 }
```

## Tuning from the phone

Every setting is overridable from the query string, so it can be retuned in the
field without republishing — same idea as the original.

| Parameter | Purpose |
|---|---|
| `lat`, `lon`, `elev` | Override the site coordinates |
| `heading` | Compass bearing of the straight legs |
| `length`, `turn` | Straight leg and turn radius, in metres |
| `speed`, `alt` | Airspeed in m/s, altitude in metres |
| `bank`, `rolltime` | Max roll in degrees, seconds to roll into it |
| `path` | `racetrack`, `circle`, `eight` |
| `minacc` | Ignore GPS fixes worse than this many metres |
| `avg` | Fixes averaged together to suppress wander |
| `smooth` | Seconds to ease to a corrected GPS position |
| `smoothrot` | Seconds for the heading estimate to settle |

## Running it

```bash
npm run serve
```

**This cannot be meaningfully tested on a desktop.** The camera is configured
`phone: AR, desktop: disabled`, and more importantly GPS anchoring only tells
you the truth outdoors, on the device, at the location. Connect a phone with
the [8th Wall desktop app](https://8thwall.org/downloads) — see
[these instructions](https://8th.io/connect-device).

## What is verified, and what is not

Verified against the running runtime:

- Builds and type-checks clean; all three components register; the scene graph
  loads with the intended hierarchy.
- The three three.js/ECS convention differences above, tested directly.
- The circuit geometry: constant **60.0 m/s** all the way round, outbound leg on
  bearing **114.5°** and the return on **294.5°**, altitude held at 50 m
  (vertical motion is left to the GLB's own clip), 88.3 s per 5296 m lap.

**Not verified — needs a phone, outdoors:**

- The GPS + compass fusion in `gps-anchor.ts`. The heading correction in
  particular is the weak link, exactly as in the original: iOS exposes a true
  north heading, Android varies by device and can be tens of degrees out until
  the magnetometer is calibrated by waving a figure-eight. A heading error puts
  the aircraft in the wrong part of the sky.
- Whether SLAM drift over a long session degrades the anchor. The original had
  no tracker to drift; this one leans on SLAM between fixes.
- Anything about how it actually looks: the aircraft at a few hundred metres,
  banner legibility, sunlight, thermal throttling.

## Deploying

GitHub Actions publishes to GitHub Pages on a push to `main`. HTTPS is a hard
requirement — camera, geolocation and motion sensors are all refused on plain
HTTP.
