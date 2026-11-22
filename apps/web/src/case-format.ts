import type { CaseProjection } from './state/controller.js'

const ROMAN_NUMERALS = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
] as const

/** Derives the UTC slot date that owns a case projection, when it has one. */
export function slotIdForProjection(
  projection: CaseProjection | undefined,
): string | undefined {
  if (projection === undefined || projection.view === 'NO_CASE')
    return undefined
  if (projection.view === 'NOT_STARTED') return projection.slotId
  const close = Date.parse(projection.closesAt)
  if (!Number.isFinite(close)) return undefined
  return new Date(close - 1).toISOString().slice(0, 10)
}

export function formatUtc(value: string): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZone: 'UTC',
    timeZoneName: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

/** Formats a `YYYY-MM-DD` UTC slot for display, keeping invalid input as-is. */
export function formatSlotDate(slotId: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(slotId)) return slotId
  const date = new Date(`${slotId}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return slotId
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(date)
}

/** Decorative numeral for small ordinal markers; falls back to digits. */
export function romanNumeral(value: number): string {
  return ROMAN_NUMERALS[value - 1] ?? String(value)
}
