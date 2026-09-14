import type { ContentPack } from '../schema.js'

/** Original S1-authored fixture. Keep this module inside the server-only database boundary. */
export const asterQuayContentPack = {
  answerEntityId: 'mira-vale',
  author: 'Loremaster project',
  briefing:
    'A replacement tide ledger appeared in the quay archive overnight. Its hours are written backwards, a notation invented by the tide archivist to distinguish forecasts from observations. Who prepared the replacement?',
  caseId: 'missing-ninth-bell',
  closesAt: '2030-01-02T00:00:00.000Z',
  contentVersion: '1.0.0',
  entities: [
    {
      aliases: ['Mira'],
      canonicalName: 'Mira Vale',
      id: 'mira-vale',
      role: 'Tide archivist; devised the reversed-hour notation',
    },
    {
      aliases: ['Oren'],
      canonicalName: 'Oren Pell',
      id: 'oren-pell',
      role: 'Bell keeper; records hours as ordinary numerals',
    },
    {
      aliases: ['Tessa'],
      canonicalName: 'Tessa Reed',
      id: 'tessa-reed',
      role: 'Glassmaker; marks work with a three-dot stamp',
    },
    {
      aliases: ['Ivo'],
      canonicalName: 'Ivo Senn',
      id: 'ivo-senn',
      role: 'Courier; records deliveries using numbered knots',
    },
  ],
  evidence: [
    {
      explanation:
        "The public role catalog and briefing identify Mira's unique notation. Evidence 1 focuses on that clue.",
      order: 1,
      text: 'The unusual hour marks indicate authorship, not a damaged clock.',
    },
    {
      explanation: 'Evidence 2 excludes two alternatives.',
      order: 2,
      text: 'The bell keeper uses ordinary numerals, while the courier uses knots.',
    },
    {
      explanation: 'Evidence 3 identifies the role.',
      order: 3,
      text: "The replacement follows the tide archivist's forecast notation.",
    },
    {
      explanation: 'Evidence 4 connects it to the name.',
      order: 4,
      text: "The archive's staff register identifies its tide archivist as Mira Vale.",
    },
  ],
  opensAt: '2030-01-01T00:00:00.000Z',
  provenance: 'ORIGINAL_AUTHORED',
  regionIds: ['aster-quay'],
  regions: [{ displayName: 'Aster Quay', id: 'aster-quay' }],
  revisionNumber: 1,
  schemaVersion: 1,
  slotId: '2030-01-01',
  sourceIds: ['aster-quay/staff-and-notation-v1'],
  sources: [
    {
      citation: 'Original internal staff and notation reference, version 1',
      id: 'aster-quay/staff-and-notation-v1',
    },
  ],
  stableKey: 'aster-quay',
  title: 'The Missing Ninth Bell',
} as const satisfies ContentPack
