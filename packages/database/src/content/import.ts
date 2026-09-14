import { createHash } from 'node:crypto'

import type { PoolClient } from 'pg'

import type { Database } from '../migrate.js'
import type { ContentDiagnosticCode, ContentPack } from './schema.js'
import { validateContentPack } from './validate.js'

export const CONTENT_IMPORT_DIAGNOSTIC_CODES = [
  'DATABASE_UNAVAILABLE',
  'DUPLICATE_REVISION',
  'IMPORT_CONSTRAINT_VIOLATION',
  'PUBLISHED_CONTENT_IMMUTABLE',
  'SLOT_OVERLAP',
] as const

export type ContentImportDiagnosticCode =
  ContentDiagnosticCode | (typeof CONTENT_IMPORT_DIAGNOSTIC_CODES)[number]

export interface ContentImportDiagnostic {
  readonly code: ContentImportDiagnosticCode
  readonly path: string
}

export type ContentImportMode = 'DRAFT' | 'PUBLISH'

export type ContentImportResult =
  | {
      readonly ok: true
      readonly revisionId: string
      readonly status: 'DRAFT' | 'PUBLISHED'
    }
  | {
      readonly diagnostics: readonly ContentImportDiagnostic[]
      readonly ok: false
    }

export type ContentDryRunResult =
  | { readonly ok: true; readonly status: 'VALID' }
  | {
      readonly diagnostics: readonly ContentImportDiagnostic[]
      readonly ok: false
    }

interface PostgreSqlError {
  readonly code?: unknown
  readonly constraint?: unknown
}

function deterministicUuid(scope: string): string {
  const bytes = createHash('sha256')
    .update(scope, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hexadecimal = bytes.toString('hex')
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`
}

function revisionUuid(pack: ContentPack): string {
  return deterministicUuid(`revision:${pack.stableKey}:${pack.revisionNumber}`)
}

function entityUuid(revisionId: string, entityId: string): string {
  return deterministicUuid(`entity:${revisionId}:${entityId}`)
}

function diagnostic(
  code: ContentImportDiagnosticCode,
  path = '$',
): ContentImportDiagnostic {
  return { code, path }
}

function mapDatabaseError(error: unknown): ContentImportDiagnostic {
  if (typeof error !== 'object' || error === null) {
    return diagnostic('DATABASE_UNAVAILABLE')
  }
  const { code, constraint } = error as PostgreSqlError
  if (code === '23P01') return diagnostic('SLOT_OVERLAP', '$.opensAt')
  if (
    code === '23505' &&
    (constraint === 'case_revisions_pack_id_revision_number_key' ||
      constraint === 'case_revisions_pkey')
  ) {
    return diagnostic('DUPLICATE_REVISION', '$.revisionNumber')
  }
  if (code === '55000') return diagnostic('PUBLISHED_CONTENT_IMMUTABLE')
  if (typeof code === 'string' && code.startsWith('23')) {
    return diagnostic('IMPORT_CONSTRAINT_VIOLATION')
  }
  return diagnostic('DATABASE_UNAVAILABLE')
}

async function beginImporterTransaction(
  db: Database,
  readOnly: boolean,
): Promise<PoolClient> {
  const client = await db.connect()
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
    await client.query('SET LOCAL ROLE loremaster_importer')
    return client
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
    throw error
  }
}

async function findExistingRevision(
  client: PoolClient,
  pack: ContentPack,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM loremaster.case_revisions revision
       JOIN loremaster.content_packs pack ON pack.id = revision.pack_id
       WHERE pack.stable_key = $1 AND revision.revision_number = $2
     ) AS exists`,
    [pack.stableKey, pack.revisionNumber],
  )
  return result.rows[0]?.exists === true
}

async function hasPublishedOverlap(
  client: PoolClient,
  pack: ContentPack,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM loremaster.case_revisions
       WHERE status = 'PUBLISHED'
         AND tstzrange(opens_at, closes_at, '[)') && tstzrange($1::timestamptz, $2::timestamptz, '[)')
     ) AS exists`,
    [pack.opensAt, pack.closesAt],
  )
  return result.rows[0]?.exists === true
}

async function insertPackGraph(
  client: PoolClient,
  pack: ContentPack,
  revisionId: string,
): Promise<void> {
  const packId = deterministicUuid(`pack:${pack.stableKey}`)
  await client.query(
    `INSERT INTO loremaster.content_packs (id, stable_key)
     VALUES ($1, $2)
     ON CONFLICT (stable_key) DO NOTHING`,
    [packId, pack.stableKey],
  )
  const storedPack = await client.query<{ id: string }>(
    'SELECT id::text FROM loremaster.content_packs WHERE stable_key = $1',
    [pack.stableKey],
  )
  const storedPackId = storedPack.rows[0]?.id
  if (storedPackId === undefined) throw new Error('content pack lookup failed')

  await client.query(
    `INSERT INTO loremaster.case_revisions
       (id, pack_id, revision_number, slot_id, opens_at, closes_at, briefing,
        case_key, title, author, provenance, content_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      revisionId,
      storedPackId,
      pack.revisionNumber,
      pack.slotId,
      pack.opensAt,
      pack.closesAt,
      pack.briefing,
      pack.caseId,
      pack.title,
      pack.author,
      pack.provenance,
      pack.contentVersion,
    ],
  )

  const entityIds = new Map<string, string>()
  for (const entity of pack.entities) {
    const storedEntityId = entityUuid(revisionId, entity.id)
    entityIds.set(entity.id, storedEntityId)
    await client.query(
      `INSERT INTO loremaster.case_entities
         (revision_id, entity_id, canonical_name, role)
       VALUES ($1, $2, $3, $4)`,
      [revisionId, storedEntityId, entity.canonicalName, entity.role],
    )
    for (const alias of entity.aliases) {
      await client.query(
        `INSERT INTO loremaster.entity_aliases (revision_id, entity_id, alias)
         VALUES ($1, $2, $3)`,
        [revisionId, storedEntityId, alias],
      )
    }
  }

  for (const region of pack.regions) {
    await client.query(
      `INSERT INTO loremaster.region_catalog (id) VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [region.id],
    )
  }
  const regionById = new Map(pack.regions.map((region) => [region.id, region]))
  for (const regionId of pack.regionIds) {
    await client.query(
      `INSERT INTO loremaster.revision_regions (revision_id, region_id, display_name)
       VALUES ($1, $2, $3)`,
      [revisionId, regionId, regionById.get(regionId)!.displayName],
    )
  }

  for (const evidence of pack.evidence) {
    await client.query(
      `INSERT INTO loremaster.case_evidence
         (revision_id, evidence_order, evidence_text, explanation)
       VALUES ($1, $2, $3, $4)`,
      [revisionId, evidence.order, evidence.text, evidence.explanation],
    )
  }

  const sourceById = new Map(pack.sources.map((source) => [source.id, source]))
  for (const [index, sourceId] of pack.sourceIds.entries()) {
    await client.query(
      `INSERT INTO loremaster.case_sources
         (revision_id, source_order, source_id, citation)
       VALUES ($1, $2, $3, $4)`,
      [revisionId, index + 1, sourceId, sourceById.get(sourceId)!.citation],
    )
  }

  const answerId = entityIds.get(pack.answerEntityId)
  if (answerId === undefined) throw new Error('answer entity lookup failed')
  await client.query(
    'UPDATE loremaster.case_revisions SET answer_entity_id = $2 WHERE id = $1',
    [revisionId, answerId],
  )
}

export async function importContentPack(
  db: Database,
  input: unknown,
  mode: ContentImportMode,
): Promise<ContentImportResult> {
  let client: PoolClient | undefined
  try {
    client = await beginImporterTransaction(db, false)
    const validation = validateContentPack(input)
    if (!validation.ok) {
      await client.query('ROLLBACK')
      return { diagnostics: validation.diagnostics, ok: false }
    }
    const pack = validation.value
    if (await findExistingRevision(client, pack)) {
      await client.query('ROLLBACK')
      return {
        diagnostics: [diagnostic('DUPLICATE_REVISION', '$.revisionNumber')],
        ok: false,
      }
    }

    const revisionId = revisionUuid(pack)
    await insertPackGraph(client, pack, revisionId)
    if (mode === 'PUBLISH') {
      await client.query(
        `UPDATE loremaster.case_revisions
         SET status = 'PUBLISHED', published_at = clock_timestamp()
         WHERE id = $1`,
        [revisionId],
      )
    }
    await client.query('COMMIT')
    return {
      ok: true,
      revisionId,
      status: mode === 'PUBLISH' ? 'PUBLISHED' : 'DRAFT',
    }
  } catch (error) {
    if (client !== undefined)
      await client.query('ROLLBACK').catch(() => undefined)
    return { diagnostics: [mapDatabaseError(error)], ok: false }
  } finally {
    client?.release()
  }
}

export async function dryRunContentPack(
  db: Database,
  input: unknown,
): Promise<ContentDryRunResult> {
  let client: PoolClient | undefined
  try {
    client = await beginImporterTransaction(db, true)
    const validation = validateContentPack(input)
    if (!validation.ok) {
      await client.query('ROLLBACK')
      return { diagnostics: validation.diagnostics, ok: false }
    }
    if (await findExistingRevision(client, validation.value)) {
      await client.query('ROLLBACK')
      return {
        diagnostics: [diagnostic('DUPLICATE_REVISION', '$.revisionNumber')],
        ok: false,
      }
    }
    if (await hasPublishedOverlap(client, validation.value)) {
      await client.query('ROLLBACK')
      return {
        diagnostics: [diagnostic('SLOT_OVERLAP', '$.opensAt')],
        ok: false,
      }
    }
    await client.query('ROLLBACK')
    return { ok: true, status: 'VALID' }
  } catch (error) {
    if (client !== undefined)
      await client.query('ROLLBACK').catch(() => undefined)
    return { diagnostics: [mapDatabaseError(error)], ok: false }
  } finally {
    client?.release()
  }
}
