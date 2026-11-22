import { describe, expect, it } from 'vitest'

import {
  formatSlotDate,
  formatUtc,
  romanNumeral,
  slotIdForProjection,
} from '../../apps/web/src/case-format.js'
import type { CaseProjection } from '../../apps/web/src/state/controller.js'

const ACTIVE_PROJECTION: CaseProjection = {
  view: 'ATTEMPT',
  state: 'ACTIVE',
  attemptId: '00000000-0000-4000-8000-000000000001',
  version: 1,
  startedAt: '2029-12-31T00:00:00.000Z',
  closesAt: '2030-01-01T00:00:00.000Z',
  evidenceLevel: 0,
  wrongGuessesAtLevel: 0,
  totalWrongGuesses: 0,
  briefing: 'A sealed record.',
  suggestions: [
    {
      entityId: 'harbor-master',
      canonicalName: 'Harbor Master',
      publicRole: 'Keeper of tides',
      aliases: ['Master'],
    },
    {
      entityId: 'night-clerk',
      canonicalName: 'Night Clerk',
      publicRole: 'Keeper of ledgers',
      aliases: ['Clerk'],
    },
  ],
  guessHistory: [],
  evidence: [],
}

describe('case presentation helpers', () => {
  it('derives the owning UTC slot from every case projection shape', () => {
    expect(slotIdForProjection(undefined)).toBeUndefined()
    expect(slotIdForProjection({ view: 'NO_CASE' })).toBeUndefined()
    expect(
      slotIdForProjection({
        view: 'NOT_STARTED',
        slotId: '2029-12-31',
        opensAt: '2029-12-31T00:00:00.000Z',
        closesAt: '2030-01-01T00:00:00.000Z',
      }),
    ).toBe('2029-12-31')
    expect(slotIdForProjection(ACTIVE_PROJECTION)).toBe('2029-12-31')
    expect(
      slotIdForProjection({ ...ACTIVE_PROJECTION, closesAt: 'not-a-time' }),
    ).toBeUndefined()
  })

  it('formats slot dates in UTC and keeps malformed slots verbatim', () => {
    expect(formatSlotDate('2029-12-31')).toBe('December 31, 2029')
    expect(formatSlotDate('2030-01-01')).toBe('January 1, 2030')
    expect(formatSlotDate('31/12/2029')).toBe('31/12/2029')
    expect(formatSlotDate('')).toBe('')
  })

  it('keeps the existing UTC closing-time format', () => {
    expect(formatUtc('2030-01-01T00:00:00.000Z')).toMatch(
      /^Jan 1, 2030, 12:00\sAM UTC$/u,
    )
  })

  it('uses roman numerals for evidence markers and digits beyond the table', () => {
    expect([1, 2, 3, 4].map(romanNumeral)).toEqual(['I', 'II', 'III', 'IV'])
    expect(romanNumeral(0)).toBe('0')
    expect(romanNumeral(11)).toBe('11')
  })
})
