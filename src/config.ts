import { IGNORE_LINK_SETTINGS, LOCKED } from './location'

/**
 * Query-string configuration, with the same semantics as
 * tccc-ar-test/src/config.js — every setting overridable from the address bar,
 * which is what makes the thing tunable in the field without a redeploy.
 */
export const params = new URLSearchParams(location.search)

/**
 * Whether the numbers in the link are being thrown away.
 *
 * Two separate reasons, and they are not the same thing:
 *
 *   LOCKED                 nothing from a link is ever honoured, including
 *                          from the map picker. A deployment that must not be
 *                          movable by anyone.
 *   IGNORE_LINK_SETTINGS   a printed QR has gone stale, so links are ignored
 *                          *unless* they say `link=1` — which is what the
 *                          picker emits, so authoring still works.
 */
export const linkIgnored = (): boolean =>
  LOCKED || (IGNORE_LINK_SETTINGS && params.get('link') !== '1')

/**
 * A parameter that decides *which experience this is* — where it stands, which
 * way it runs, how big and how fast. Suppressed when the link is being
 * ignored, so the shipped values win. Presentation and tuning parameters go
 * through `num`/`flag` instead and stay live either way, since nothing on a
 * printed code sets them and they cannot move the aircraft.
 */
export const placed = (key: string): string | null => (linkIgnored() ? null : params.get(key))

/**
 * A placement number from the query string, or the fallback.
 *
 * Deliberately not `Number(x) || fallback`: that treats a legitimate 0 as
 * absent, and longitude 0 is the Greenwich meridian — which runs through
 * London, the one place this is guaranteed to be used.
 */
export const placedNum = (key: string, fallback: number): number => {
  const raw = placed(key)
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export const num = (key: string, fallback: number): number => {
  const value = Number.parseFloat(params.get(key) ?? '')
  return Number.isFinite(value) ? value : fallback
}

export const flag = (key: string, fallback: boolean): boolean => {
  if (!params.has(key)) return fallback
  const value = (params.get(key) ?? '').toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'no'
}
