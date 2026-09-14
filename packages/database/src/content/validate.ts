import {
  CONTENT_PACK_LIMITS,
  CONTENT_PACK_SCHEMA_VERSION,
  CONTENT_PROVENANCE,
  type ContentDiagnostic,
  type ContentDiagnosticCode,
  type ContentPackEntity,
  type ContentPackEvidence,
  type ContentPackRegion,
  type ContentPackSource,
  type ContentProvenance,
  type ContentValidationResult,
} from './schema.js'

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u
const SOURCE_IDENTIFIER_PATTERN =
  /^[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63})*$/u
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u
const SLOT_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const UTC_MIDNIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/u
const EXTERNAL_URL_PATTERN = /(?:\b[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)/iu
const UNSAFE_MARKUP_PATTERN = /[<>]|\]\s*\(|(?:javascript|data):/iu

const ROOT_FIELDS = [
  'answerEntityId',
  'author',
  'briefing',
  'caseId',
  'closesAt',
  'contentVersion',
  'entities',
  'evidence',
  'opensAt',
  'provenance',
  'regionIds',
  'regions',
  'revisionNumber',
  'schemaVersion',
  'slotId',
  'sourceIds',
  'sources',
  'stableKey',
  'title',
] as const

class ValidationContext {
  readonly diagnostics: ContentDiagnostic[] = []

  add(code: ContentDiagnosticCode, path: string): void {
    this.diagnostics.push({ code, path })
  }

  finish(): readonly ContentDiagnostic[] {
    const unique = new Map(
      this.diagnostics.map((diagnostic) => [
        `${diagnostic.path}\u0000${diagnostic.code}`,
        diagnostic,
      ]),
    )
    return [...unique.values()].sort(
      (left, right) =>
        left.path.localeCompare(right.path, 'en') ||
        left.code.localeCompare(right.code, 'en'),
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  context: ValidationContext,
): void {
  const allowlist = new Set(allowed)
  for (const key of Object.keys(value).sort()) {
    if (!allowlist.has(key)) context.add('UNKNOWN_FIELD', `${path}.${key}`)
  }
}

interface StringOptions {
  readonly format?: RegExp
  readonly max: number
  readonly plainText?: boolean
}

function readString(
  value: unknown,
  path: string,
  options: StringOptions,
  context: ValidationContext,
): string | undefined {
  if (typeof value !== 'string') {
    context.add('INVALID_TYPE', path)
    return undefined
  }
  if (value.length < 1 || value.length > options.max) {
    context.add('OUT_OF_BOUNDS', path)
  }
  if (options.format !== undefined && !options.format.test(value)) {
    context.add('INVALID_FORMAT', path)
  }
  if (options.plainText === true) {
    if (EXTERNAL_URL_PATTERN.test(value)) context.add('EXTERNAL_URL', path)
    if (UNSAFE_MARKUP_PATTERN.test(value)) context.add('UNSAFE_MARKUP', path)
  }
  return value
}

function readStringArray(
  value: unknown,
  path: string,
  maximum: number,
  itemOptions: StringOptions,
  context: ValidationContext,
): string[] {
  if (!Array.isArray(value)) {
    context.add('INVALID_TYPE', path)
    return []
  }
  if (value.length < 1 || value.length > maximum) {
    context.add('OUT_OF_BOUNDS', path)
  }
  const values = value.map((item, index) =>
    readString(item, `${path}[${index}]`, itemOptions, context),
  )
  return values.filter((item): item is string => item !== undefined)
}

function reportDuplicates(
  values: readonly string[],
  path: string,
  context: ValidationContext,
): void {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
    if (seen.has(normalized))
      context.add('DUPLICATE_VALUE', `${path}[${index}]`)
    seen.add(normalized)
  })
}

function readRegions(
  value: unknown,
  context: ValidationContext,
): ContentPackRegion[] {
  if (!Array.isArray(value)) {
    context.add('INVALID_TYPE', '$.regions')
    return []
  }
  if (value.length < 1 || value.length > CONTENT_PACK_LIMITS.regions) {
    context.add('OUT_OF_BOUNDS', '$.regions')
  }
  const regions: ContentPackRegion[] = []
  value.forEach((item, index) => {
    const path = `$.regions[${index}]`
    if (!isRecord(item)) {
      context.add('INVALID_TYPE', path)
      return
    }
    rejectUnknownFields(item, ['displayName', 'id'], path, context)
    const id = readString(
      item.id,
      `${path}.id`,
      { format: IDENTIFIER_PATTERN, max: CONTENT_PACK_LIMITS.id },
      context,
    )
    const displayName = readString(
      item.displayName,
      `${path}.displayName`,
      { max: CONTENT_PACK_LIMITS.regionDisplayName, plainText: true },
      context,
    )
    if (id !== undefined && displayName !== undefined)
      regions.push({ displayName, id })
  })
  reportDuplicates(
    regions.map((region) => region.id),
    '$.regions',
    context,
  )
  return regions
}

function readEntities(
  value: unknown,
  context: ValidationContext,
): ContentPackEntity[] {
  if (!Array.isArray(value)) {
    context.add('INVALID_TYPE', '$.entities')
    return []
  }
  if (value.length < 2 || value.length > CONTENT_PACK_LIMITS.entities) {
    context.add('OUT_OF_BOUNDS', '$.entities')
  }
  const entities: ContentPackEntity[] = []
  value.forEach((item, index) => {
    const path = `$.entities[${index}]`
    if (!isRecord(item)) {
      context.add('INVALID_TYPE', path)
      return
    }
    rejectUnknownFields(
      item,
      ['aliases', 'canonicalName', 'id', 'role'],
      path,
      context,
    )
    const id = readString(
      item.id,
      `${path}.id`,
      { format: IDENTIFIER_PATTERN, max: CONTENT_PACK_LIMITS.id },
      context,
    )
    const canonicalName = readString(
      item.canonicalName,
      `${path}.canonicalName`,
      { max: CONTENT_PACK_LIMITS.canonicalName, plainText: true },
      context,
    )
    const role = readString(
      item.role,
      `${path}.role`,
      { max: CONTENT_PACK_LIMITS.role, plainText: true },
      context,
    )
    const aliases = readStringArray(
      item.aliases,
      `${path}.aliases`,
      CONTENT_PACK_LIMITS.aliasesPerEntity,
      { max: CONTENT_PACK_LIMITS.alias, plainText: true },
      context,
    )
    reportDuplicates(aliases, `${path}.aliases`, context)
    if (id !== undefined && canonicalName !== undefined && role !== undefined) {
      entities.push({ aliases, canonicalName, id, role })
    }
  })
  reportDuplicates(
    entities.map((entity) => entity.id),
    '$.entities',
    context,
  )
  reportAmbiguousAliases(entities, context)
  return entities
}

function reportAmbiguousAliases(
  entities: readonly ContentPackEntity[],
  context: ValidationContext,
): void {
  const owners = new Map<string, string>()
  entities.forEach((entity, entityIndex) => {
    const names = [entity.canonicalName, ...entity.aliases]
    names.forEach((name, nameIndex) => {
      const normalized = name
        .normalize('NFKC')
        .trim()
        .toLocaleLowerCase('en-US')
      const owner = owners.get(normalized)
      if (owner !== undefined && owner !== entity.id) {
        const path =
          nameIndex === 0
            ? `$.entities[${entityIndex}].canonicalName`
            : `$.entities[${entityIndex}].aliases[${nameIndex - 1}]`
        context.add('AMBIGUOUS_ALIAS', path)
      } else {
        owners.set(normalized, entity.id)
      }
    })
  })
}

function readEvidence(
  value: unknown,
  context: ValidationContext,
): ContentPackEvidence[] {
  if (!Array.isArray(value)) {
    context.add('INVALID_TYPE', '$.evidence')
    return []
  }
  if (value.length !== CONTENT_PACK_LIMITS.evidenceEntries) {
    context.add('OUT_OF_BOUNDS', '$.evidence')
  }
  const evidence: ContentPackEvidence[] = []
  value.forEach((item, index) => {
    const path = `$.evidence[${index}]`
    if (!isRecord(item)) {
      context.add('INVALID_TYPE', path)
      return
    }
    rejectUnknownFields(item, ['explanation', 'order', 'text'], path, context)
    const order = item.order
    if (!Number.isInteger(order) || typeof order !== 'number') {
      context.add('INVALID_TYPE', `${path}.order`)
    } else if (order < 1 || order > 4) {
      context.add('OUT_OF_BOUNDS', `${path}.order`)
    }
    const text = readString(
      item.text,
      `${path}.text`,
      { max: CONTENT_PACK_LIMITS.evidenceText, plainText: true },
      context,
    )
    const explanation = readString(
      item.explanation,
      `${path}.explanation`,
      { max: CONTENT_PACK_LIMITS.explanation, plainText: true },
      context,
    )
    if (
      typeof order === 'number' &&
      Number.isInteger(order) &&
      order >= 1 &&
      order <= 4 &&
      text !== undefined &&
      explanation !== undefined
    ) {
      evidence.push({ explanation, order: order as 1 | 2 | 3 | 4, text })
    }
  })
  reportDuplicates(
    evidence.map((entry) => String(entry.order)),
    '$.evidence',
    context,
  )
  for (let order = 1; order <= 4; order += 1) {
    if (!evidence.some((entry) => entry.order === order)) {
      context.add('INVALID_FORMAT', `$.evidence[order=${order}]`)
    }
  }
  return evidence
}

function readSources(
  value: unknown,
  context: ValidationContext,
): ContentPackSource[] {
  if (!Array.isArray(value)) {
    context.add('INVALID_TYPE', '$.sources')
    return []
  }
  if (value.length < 1 || value.length > CONTENT_PACK_LIMITS.sources) {
    context.add('OUT_OF_BOUNDS', '$.sources')
  }
  const sources: ContentPackSource[] = []
  value.forEach((item, index) => {
    const path = `$.sources[${index}]`
    if (!isRecord(item)) {
      context.add('INVALID_TYPE', path)
      return
    }
    rejectUnknownFields(item, ['citation', 'id'], path, context)
    const id = readString(
      item.id,
      `${path}.id`,
      {
        format: SOURCE_IDENTIFIER_PATTERN,
        max: CONTENT_PACK_LIMITS.sourceId,
        plainText: true,
      },
      context,
    )
    const citation = readString(
      item.citation,
      `${path}.citation`,
      { max: CONTENT_PACK_LIMITS.citation, plainText: true },
      context,
    )
    if (id !== undefined && citation !== undefined)
      sources.push({ citation, id })
  })
  reportDuplicates(
    sources.map((source) => source.id),
    '$.sources',
    context,
  )
  return sources
}

function validateWindow(
  slotId: string | undefined,
  opensAt: string | undefined,
  closesAt: string | undefined,
  context: ValidationContext,
): void {
  if (slotId === undefined || opensAt === undefined || closesAt === undefined)
    return
  const openMilliseconds = Date.parse(opensAt)
  const closeMilliseconds = Date.parse(closesAt)
  const canonicalOpen = `${slotId}T00:00:00.000Z`
  const expectedClose = Number.isFinite(openMilliseconds)
    ? new Date(openMilliseconds + 86_400_000).toISOString()
    : ''
  const isExact =
    SLOT_PATTERN.test(slotId) &&
    UTC_MIDNIGHT_PATTERN.test(opensAt) &&
    UTC_MIDNIGHT_PATTERN.test(closesAt) &&
    Number.isFinite(openMilliseconds) &&
    Number.isFinite(closeMilliseconds) &&
    new Date(openMilliseconds).toISOString() === canonicalOpen &&
    new Date(closeMilliseconds).toISOString() === expectedClose
  if (!isExact) context.add('INVALID_DAY_WINDOW', '$.opensAt')
}

function validateReferences(
  answerEntityId: string | undefined,
  regionIds: readonly string[],
  sourceIds: readonly string[],
  entities: readonly ContentPackEntity[],
  regions: readonly ContentPackRegion[],
  sources: readonly ContentPackSource[],
  context: ValidationContext,
): void {
  if (
    answerEntityId !== undefined &&
    !entities.some((entity) => entity.id === answerEntityId)
  ) {
    context.add('UNKNOWN_ANSWER_ID', '$.answerEntityId')
  }
  const knownRegions = new Set(regions.map((region) => region.id))
  regionIds.forEach((regionId, index) => {
    if (!knownRegions.has(regionId))
      context.add('UNKNOWN_REGION_ID', `$.regionIds[${index}]`)
  })
  const knownSources = new Set(sources.map((source) => source.id))
  sourceIds.forEach((sourceId, index) => {
    if (!knownSources.has(sourceId))
      context.add('UNKNOWN_SOURCE_ID', `$.sourceIds[${index}]`)
  })
}

export function validateContentPack(input: unknown): ContentValidationResult {
  const context = new ValidationContext()
  if (!isRecord(input)) {
    return { diagnostics: [{ code: 'INVALID_TYPE', path: '$' }], ok: false }
  }
  rejectUnknownFields(input, ROOT_FIELDS, '$', context)

  const stableKey = readString(
    input.stableKey,
    '$.stableKey',
    { format: IDENTIFIER_PATTERN, max: CONTENT_PACK_LIMITS.id },
    context,
  )
  const caseId = readString(
    input.caseId,
    '$.caseId',
    { format: IDENTIFIER_PATTERN, max: CONTENT_PACK_LIMITS.caseId },
    context,
  )
  const author = readString(
    input.author,
    '$.author',
    { max: CONTENT_PACK_LIMITS.author, plainText: true },
    context,
  )
  const contentVersion = readString(
    input.contentVersion,
    '$.contentVersion',
    { format: VERSION_PATTERN, max: CONTENT_PACK_LIMITS.contentVersion },
    context,
  )
  const title = readString(
    input.title,
    '$.title',
    { max: CONTENT_PACK_LIMITS.title, plainText: true },
    context,
  )
  const briefing = readString(
    input.briefing,
    '$.briefing',
    { max: CONTENT_PACK_LIMITS.briefing, plainText: true },
    context,
  )
  const answerEntityId = readString(
    input.answerEntityId,
    '$.answerEntityId',
    { format: IDENTIFIER_PATTERN, max: CONTENT_PACK_LIMITS.id },
    context,
  )
  const slotId = readString(
    input.slotId,
    '$.slotId',
    { format: SLOT_PATTERN, max: 10 },
    context,
  )
  const opensAt = readString(input.opensAt, '$.opensAt', { max: 24 }, context)
  const closesAt = readString(
    input.closesAt,
    '$.closesAt',
    { max: 24 },
    context,
  )

  const schemaVersion = input.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    context.add('INVALID_TYPE', '$.schemaVersion')
  } else if (schemaVersion !== CONTENT_PACK_SCHEMA_VERSION) {
    context.add('INVALID_FORMAT', '$.schemaVersion')
  }
  const revisionNumber = input.revisionNumber
  if (typeof revisionNumber !== 'number' || !Number.isInteger(revisionNumber)) {
    context.add('INVALID_TYPE', '$.revisionNumber')
  } else if (revisionNumber < 1 || revisionNumber > 2_147_483_647) {
    context.add('OUT_OF_BOUNDS', '$.revisionNumber')
  }
  const provenance = readString(
    input.provenance,
    '$.provenance',
    { max: 32 },
    context,
  )
  if (
    provenance !== undefined &&
    !(CONTENT_PROVENANCE as readonly string[]).includes(provenance)
  ) {
    context.add('UNKNOWN_PROVENANCE', '$.provenance')
  }

  const regions = readRegions(input.regions, context)
  const entities = readEntities(input.entities, context)
  const evidence = readEvidence(input.evidence, context)
  const sources = readSources(input.sources, context)
  const regionIds = readStringArray(
    input.regionIds,
    '$.regionIds',
    CONTENT_PACK_LIMITS.regionsPerCase,
    { format: IDENTIFIER_PATTERN, max: CONTENT_PACK_LIMITS.id },
    context,
  )
  const sourceIds = readStringArray(
    input.sourceIds,
    '$.sourceIds',
    CONTENT_PACK_LIMITS.sourcesPerCase,
    {
      format: SOURCE_IDENTIFIER_PATTERN,
      max: CONTENT_PACK_LIMITS.sourceId,
      plainText: true,
    },
    context,
  )
  reportDuplicates(regionIds, '$.regionIds', context)
  reportDuplicates(sourceIds, '$.sourceIds', context)
  validateWindow(slotId, opensAt, closesAt, context)
  validateReferences(
    answerEntityId,
    regionIds,
    sourceIds,
    entities,
    regions,
    sources,
    context,
  )

  const diagnostics = context.finish()
  if (diagnostics.length > 0) return { diagnostics, ok: false }

  return {
    ok: true,
    value: {
      answerEntityId: answerEntityId!,
      author: author!,
      briefing: briefing!,
      caseId: caseId!,
      closesAt: closesAt!,
      contentVersion: contentVersion!,
      entities,
      evidence,
      opensAt: opensAt!,
      provenance: provenance as ContentProvenance,
      regionIds,
      regions,
      revisionNumber: revisionNumber as number,
      schemaVersion: schemaVersion as typeof CONTENT_PACK_SCHEMA_VERSION,
      slotId: slotId!,
      sourceIds,
      sources,
      stableKey: stableKey!,
      title: title!,
    },
  }
}
