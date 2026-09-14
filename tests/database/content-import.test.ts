import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asterQuayContentPack } from '../../packages/database/dist/content/fixtures/aster-quay.js'
import { executeContentCli } from '../../packages/database/dist/content/cli-core.js'
import {
  dryRunContentPack,
  importContentPack,
  type ContentPack,
} from '../../packages/database/dist/content/index.js'
import {
  closeDatabase,
  database,
  type Database,
} from '../../packages/database/dist/migrate.js'

const connectionString = process.env.LOREMASTER_TEST_DATABASE_URL
if (connectionString === undefined) {
  throw new Error(
    'LOREMASTER_TEST_DATABASE_URL is required; run this suite with `pnpm test:database`',
  )
}

let db: Database
const temporaryDirectories: string[] = []

beforeAll(() => {
  db = database(connectionString)
})

afterAll(async () => {
  await closeDatabase(db)
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

function packFor(slotId: string, identity = randomUUID()): ContentPack {
  const nextDay = new Date(`${slotId}T00:00:00.000Z`)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  const stableSuffix = identity.replaceAll('-', '')
  return {
    ...structuredClone(asterQuayContentPack),
    caseId: `case-${stableSuffix}`,
    closesAt: nextDay.toISOString(),
    opensAt: `${slotId}T00:00:00.000Z`,
    slotId,
    stableKey: `pack-${stableSuffix}`,
  }
}

async function countPack(stableKey: string): Promise<string> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM loremaster.content_packs WHERE stable_key = $1',
    [stableKey],
  )
  return result.rows[0]?.count ?? '0'
}

describe('S4.5a transactional content importer', () => {
  it('inserts a complete draft graph without publishing it', async () => {
    const pack = packFor('2050-01-01')

    const result = await importContentPack(db, pack, 'DRAFT')

    expect(result).toMatchObject({ ok: true, status: 'DRAFT' })
    if (!result.ok) throw new Error('draft import unexpectedly failed')
    const graph = await db.query<{
      answer_count: string
      author: string
      case_key: string
      content_version: string
      entity_count: string
      evidence_count: string
      provenance: string
      source_count: string
      status: string
      title: string
    }>(
      `SELECT revision.status, revision.case_key, revision.title,
              revision.author, revision.provenance, revision.content_version,
              (revision.answer_entity_id IS NOT NULL)::int::text AS answer_count,
              count(DISTINCT entity.entity_id)::text AS entity_count,
              count(DISTINCT evidence.evidence_order)::text AS evidence_count,
              count(DISTINCT source.source_order)::text AS source_count
       FROM loremaster.case_revisions revision
       JOIN loremaster.case_entities entity ON entity.revision_id = revision.id
       JOIN loremaster.case_evidence evidence ON evidence.revision_id = revision.id
       JOIN loremaster.case_sources source ON source.revision_id = revision.id
       WHERE revision.id = $1
       GROUP BY revision.id`,
      [result.revisionId],
    )
    expect(graph.rows[0]).toEqual({
      answer_count: '1',
      author: pack.author,
      case_key: pack.caseId,
      content_version: pack.contentVersion,
      entity_count: '4',
      evidence_count: '4',
      provenance: pack.provenance,
      source_count: '1',
      status: 'DRAFT',
      title: pack.title,
    })
  })

  it('publishes the graph atomically and rejects re-import', async () => {
    const pack = packFor('2050-01-02')

    const first = await importContentPack(db, pack, 'PUBLISH')
    const second = await importContentPack(db, pack, 'PUBLISH')

    expect(first).toMatchObject({ ok: true, status: 'PUBLISHED' })
    if (!first.ok) throw new Error('publication unexpectedly failed')
    expect(second).toEqual({
      diagnostics: [{ code: 'DUPLICATE_REVISION', path: '$.revisionNumber' }],
      ok: false,
    })
    expect(await countPack(pack.stableKey)).toBe('1')
    await expect(
      db.query(
        `UPDATE loremaster.case_evidence
         SET explanation = 'changed' WHERE revision_id = $1`,
        [first.revisionId],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('rolls back malformed input without inserting a pack', async () => {
    const pack = packFor('2050-01-03')
    const malformed = { ...pack, evidence: pack.evidence.slice(0, 3) }

    const result = await importContentPack(db, malformed, 'PUBLISH')

    expect(result).toMatchObject({ ok: false })
    expect(await countPack(pack.stableKey)).toBe('0')
  })

  it('uses the exclusion constraint to arbitrate concurrent publication', async () => {
    const left = packFor('2050-01-04')
    const right = packFor('2050-01-04')

    const results = await Promise.all([
      importContentPack(db, left, 'PUBLISH'),
      importContentPack(db, right, 'PUBLISH'),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        diagnostics: [{ code: 'SLOT_OVERLAP', path: '$.opensAt' }],
        ok: false,
      },
    ])
    const failedPack = results[0]?.ok ? right : left
    expect(await countPack(failedPack.stableKey)).toBe('0')
  })
})

describe('S4.5b dry-run and operator flow', () => {
  it('dry-runs against authoritative overlap state without writing', async () => {
    const published = packFor('2050-01-05')
    const candidate = packFor('2050-01-05')
    await importContentPack(db, published, 'PUBLISH')
    const directory = await mkdtemp(path.join(tmpdir(), 'loremaster-overlap-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'pack.json')
    await writeFile(file, JSON.stringify(candidate), 'utf8')

    const before = await countPack(candidate.stableKey)
    const repositoryResult = await dryRunContentPack(db, candidate)
    const cliResult = await executeContentCli({
      db,
      mode: 'DRY_RUN',
      path: file,
    })
    const after = await countPack(candidate.stableKey)

    expect(repositoryResult).toEqual({
      diagnostics: [{ code: 'SLOT_OVERLAP', path: '$.opensAt' }],
      ok: false,
    })
    expect(cliResult).toEqual({
      diagnostics: [{ code: 'SLOT_OVERLAP', path: '$.opensAt' }],
      exitCode: 2,
      mode: 'DRY_RUN',
      ok: false,
    })
    expect({ after, before }).toEqual({ after: '0', before: '0' })
  })

  it('executes a no-write dry-run followed by a successful operator publication', async () => {
    const pack = packFor('2050-01-06')
    const directory = await mkdtemp(path.join(tmpdir(), 'loremaster-import-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'pack.json')
    await writeFile(file, JSON.stringify(pack), 'utf8')

    const command = path.resolve('packages/database/dist/content/cli.js')
    const environment = {
      ...process.env,
      LOREMASTER_IMPORT_DATABASE_URL: connectionString,
    }
    const dryRunProcess = spawnSync(
      process.execPath,
      [command, '--file', file, '--dry-run'],
      { encoding: 'utf8', env: environment },
    )
    const dryRun = JSON.parse(dryRunProcess.stdout) as unknown
    expect(dryRunProcess.status).toBe(0)
    expect(dryRun).toEqual({
      exitCode: 0,
      mode: 'DRY_RUN',
      ok: true,
      status: 'VALID',
    })
    expect(await countPack(pack.stableKey)).toBe('0')

    const publishProcess = spawnSync(
      process.execPath,
      [command, '--file', file],
      {
        encoding: 'utf8',
        env: environment,
      },
    )
    const publication = JSON.parse(publishProcess.stdout) as unknown
    expect(publishProcess.status).toBe(0)
    expect(publication).toMatchObject({
      exitCode: 0,
      mode: 'PUBLISH',
      ok: true,
      status: 'PUBLISHED',
    })
    expect(await countPack(pack.stableKey)).toBe('1')
  })
})
