import { LOCKED } from './location'

/**
 * Query-string configuration, with the same semantics as
 * tccc-ar-test/src/config.js — every setting overridable from the address bar,
 * which is what makes the thing tunable in the field without a redeploy.
 */
export const params = new URLSearchParams(location.search)

/**
 * Placement parameters are suppressed when LOCKED, so a deployed experience
 * cannot be relocated from the address bar. Presentation parameters stay live.
 */
export const placed = (key: string): string | null => (LOCKED ? null : params.get(key))

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
