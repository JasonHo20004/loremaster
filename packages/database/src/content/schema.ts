export const CONTENT_PACK_LIMITS = Object.freeze({
  alias: 80,
  aliasesPerEntity: 8,
  author: 120,
  briefing: 2_000,
  canonicalName: 80,
  caseId: 64,
  citation: 240,
  contentVersion: 32,
  entities: 32,
  evidenceEntries: 4,
  evidenceText: 1_000,
  explanation: 1_500,
  id: 64,
  regions: 8,
  regionDisplayName: 80,
  regionsPerCase: 8,
  role: 160,
  sourceId: 128,
  sources: 16,
  sourcesPerCase: 16,
  title: 120,
})

export const CONTENT_PACK_SCHEMA_VERSION = 1 as const
export const CONTENT_PROVENANCE = ['ORIGINAL_AUTHORED'] as const

export type ContentProvenance = (typeof CONTENT_PROVENANCE)[number]

export interface ContentPackEntity {
  readonly aliases: readonly string[]
  readonly canonicalName: string
  readonly id: string
  readonly role: string
}

export interface ContentPackEvidence {
  readonly explanation: string
  readonly order: 1 | 2 | 3 | 4
  readonly text: string
}

export interface ContentPackRegion {
  readonly displayName: string
  readonly id: string
}

export interface ContentPackSource {
  readonly citation: string
  readonly id: string
}

export interface ContentPack {
  readonly answerEntityId: string
  readonly author: string
  readonly briefing: string
  readonly caseId: string
  readonly closesAt: string
  readonly contentVersion: string
  readonly entities: readonly ContentPackEntity[]
  readonly evidence: readonly ContentPackEvidence[]
  readonly opensAt: string
  readonly provenance: ContentProvenance
  readonly regionIds: readonly string[]
  readonly regions: readonly ContentPackRegion[]
  readonly revisionNumber: number
  readonly schemaVersion: typeof CONTENT_PACK_SCHEMA_VERSION
  readonly slotId: string
  readonly sourceIds: readonly string[]
  readonly sources: readonly ContentPackSource[]
  readonly stableKey: string
  readonly title: string
}

export const CONTENT_DIAGNOSTIC_CODES = [
  'AMBIGUOUS_ALIAS',
  'DUPLICATE_VALUE',
  'EXTERNAL_URL',
  'INVALID_DAY_WINDOW',
  'INVALID_FORMAT',
  'INVALID_TYPE',
  'OUT_OF_BOUNDS',
  'UNKNOWN_ANSWER_ID',
  'UNKNOWN_FIELD',
  'UNKNOWN_PROVENANCE',
  'UNKNOWN_REGION_ID',
  'UNKNOWN_SOURCE_ID',
  'UNSAFE_MARKUP',
] as const

export type ContentDiagnosticCode = (typeof CONTENT_DIAGNOSTIC_CODES)[number]

/** Safe for logs: diagnostics contain stable metadata and never input values. */
export interface ContentDiagnostic {
  readonly code: ContentDiagnosticCode
  readonly path: string
}

export type ContentValidationResult =
  | { readonly ok: true; readonly value: ContentPack }
  | { readonly diagnostics: readonly ContentDiagnostic[]; readonly ok: false }
