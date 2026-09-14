import { describe, expect, it } from 'vitest'

import { asterQuayContentPack } from '../../packages/database/src/content/fixtures/aster-quay.js'
import { validateContentPack } from '../../packages/database/src/content/index.js'

function editableFixture(): Record<string, unknown> {
  return structuredClone(asterQuayContentPack) as Record<string, unknown>
}

describe('S4.4 bounded content pack validation', () => {
  it('accepts the original Aster Quay fixture', () => {
    const result = validateContentPack(asterQuayContentPack)

    expect(result).toEqual({ ok: true, value: asterQuayContentPack })
    expect(asterQuayContentPack).toMatchObject({
      answerEntityId: 'mira-vale',
      caseId: 'missing-ninth-bell',
      contentVersion: '1.0.0',
      provenance: 'ORIGINAL_AUTHORED',
      regionIds: ['aster-quay'],
      sourceIds: ['aster-quay/staff-and-notation-v1'],
      stableKey: 'aster-quay',
      title: 'The Missing Ninth Bell',
    })
    expect(asterQuayContentPack.entities).toEqual([
      expect.objectContaining({ id: 'mira-vale', canonicalName: 'Mira Vale' }),
      expect.objectContaining({ id: 'oren-pell', canonicalName: 'Oren Pell' }),
      expect.objectContaining({
        id: 'tessa-reed',
        canonicalName: 'Tessa Reed',
      }),
      expect.objectContaining({ id: 'ivo-senn', canonicalName: 'Ivo Senn' }),
    ])
    expect(
      asterQuayContentPack.evidence.map(({ order, text }) => ({ order, text })),
    ).toEqual([
      {
        order: 1,
        text: 'The unusual hour marks indicate authorship, not a damaged clock.',
      },
      {
        order: 2,
        text: 'The bell keeper uses ordinary numerals, while the courier uses knots.',
      },
      {
        order: 3,
        text: "The replacement follows the tide archivist's forecast notation.",
      },
      {
        order: 4,
        text: "The archive's staff register identifies its tide archivist as Mira Vale.",
      },
    ])
  })

  it('returns all independently detectable reference and duplicate errors', () => {
    const input = editableFixture()
    input.answerEntityId = 'absent-person'
    input.provenance = 'COPIED_FROM_WEB'
    input.regionIds = ['absent-region', 'absent-region']
    input.sourceIds = ['absent/source', 'absent/source']
    const entities = input.entities as Array<Record<string, unknown>>
    entities[1]!.aliases = ['Mira']

    const result = validateContentPack(input)

    expect(result).toEqual({
      diagnostics: [
        { code: 'UNKNOWN_ANSWER_ID', path: '$.answerEntityId' },
        { code: 'AMBIGUOUS_ALIAS', path: '$.entities[1].aliases[0]' },
        { code: 'UNKNOWN_PROVENANCE', path: '$.provenance' },
        { code: 'UNKNOWN_REGION_ID', path: '$.regionIds[0]' },
        { code: 'DUPLICATE_VALUE', path: '$.regionIds[1]' },
        { code: 'UNKNOWN_REGION_ID', path: '$.regionIds[1]' },
        { code: 'UNKNOWN_SOURCE_ID', path: '$.sourceIds[0]' },
        { code: 'DUPLICATE_VALUE', path: '$.sourceIds[1]' },
        { code: 'UNKNOWN_SOURCE_ID', path: '$.sourceIds[1]' },
      ],
      ok: false,
    })
  })

  it('rejects unsafe text, external URLs, excess length, and unknown fields', () => {
    const input = editableFixture()
    input.briefing = '<script>unsafe</script>'
    input.title = 'x'.repeat(121)
    input.extraNarrative = 'must not be accepted'
    const sources = input.sources as Array<Record<string, unknown>>
    sources[0]!.citation = 'See https://example.invalid/source'

    const result = validateContentPack(input)

    expect(result).toEqual({
      diagnostics: [
        { code: 'UNSAFE_MARKUP', path: '$.briefing' },
        { code: 'UNKNOWN_FIELD', path: '$.extraNarrative' },
        { code: 'EXTERNAL_URL', path: '$.sources[0].citation' },
        { code: 'OUT_OF_BOUNDS', path: '$.title' },
      ],
      ok: false,
    })
    expect(JSON.stringify(result)).not.toContain('script')
    expect(JSON.stringify(result)).not.toContain('example.invalid')
  })

  it('requires exactly the four unique evidence orders', () => {
    const input = editableFixture()
    const evidence = input.evidence as Array<Record<string, unknown>>
    evidence[3]!.order = 3

    const result = validateContentPack(input)

    expect(result).toEqual({
      diagnostics: [
        { code: 'DUPLICATE_VALUE', path: '$.evidence[3]' },
        { code: 'INVALID_FORMAT', path: '$.evidence[order=4]' },
      ],
      ok: false,
    })
  })

  it('rejects windows that are not one exact UTC day', () => {
    const input = editableFixture()
    input.opensAt = '2030-01-01T01:00:00.000Z'
    input.closesAt = '2030-01-02T01:00:00.000Z'

    expect(validateContentPack(input)).toEqual({
      diagnostics: [{ code: 'INVALID_DAY_WINDOW', path: '$.opensAt' }],
      ok: false,
    })
  })

  it('produces deterministic diagnostics independent of object key insertion order', () => {
    const first = editableFixture()
    first.zUnknown = true
    first.aUnknown = true
    first.title = ''
    const second = Object.fromEntries(Object.entries(first).reverse())

    expect(validateContentPack(first)).toEqual(validateContentPack(second))
  })
})
