import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

beforeAll(() => {
  db = database(connectionString)
})

afterAll(async () => {
  await closeDatabase(db)
})

interface PublishedCase {
  entityId: string
  regionId: string
  revisionId: string
  slotId: string
}

async function createPublishedCase(slotId: string): Promise<PublishedCase> {
  const packId = randomUUID()
  const revisionId = randomUUID()
  const entityId = randomUUID()
  const regionId = `region_${randomUUID().replaceAll('-', '')}`
  await db.query(
    'INSERT INTO loremaster.content_packs (id, stable_key) VALUES ($1, $2)',
    [packId, `pack_${randomUUID().replaceAll('-', '')}`],
  )
  await db.query('INSERT INTO loremaster.region_catalog (id) VALUES ($1)', [
    regionId,
  ])
  await db.query(
    `INSERT INTO loremaster.case_revisions
       (id, pack_id, revision_number, slot_id, opens_at, closes_at, briefing,
        case_key, title, author, provenance, content_version)
     VALUES ($1, $2, 1, $3, $3::date::timestamp AT TIME ZONE 'UTC',
             $3::date::timestamp AT TIME ZONE 'UTC' + interval '1 day', 'briefing',
             'test-case', 'Test case', 'Test author', 'ORIGINAL_AUTHORED', '1.0.0')`,
    [revisionId, packId, slotId],
  )
  await db.query(
    `INSERT INTO loremaster.case_entities
       (revision_id, entity_id, public_id, canonical_name, role)
     VALUES ($1, $2, $3, $4, 'suspect')`,
    [
      revisionId,
      entityId,
      `entity_${entityId.replaceAll('-', '')}`,
      `Entity ${entityId}`,
    ],
  )
  await db.query(
    `INSERT INTO loremaster.revision_regions (revision_id, region_id, display_name)
     VALUES ($1, $2, 'Region')`,
    [revisionId, regionId],
  )
  for (let order = 1; order <= 4; order += 1) {
    await db.query(
      `INSERT INTO loremaster.case_evidence
         (revision_id, evidence_order, evidence_text, explanation)
       VALUES ($1, $2, $3, $4)`,
      [revisionId, order, `evidence ${order}`, `explanation ${order}`],
    )
  }
  await db.query(
    `UPDATE loremaster.case_revisions
     SET answer_entity_id = $2, status = 'PUBLISHED', published_at = clock_timestamp()
     WHERE id = $1`,
    [revisionId, entityId],
  )
  return { entityId, regionId, revisionId, slotId }
}

async function createGuest(): Promise<{ guestId: string; sessionId: string }> {
  const guestId = randomUUID()
  const sessionId = randomUUID()
  await db.query(
    'INSERT INTO loremaster.guests (id, pseudonym) VALUES ($1, $2)',
    [guestId, `Guest ${guestId.slice(0, 8)}`],
  )
  await db.query(
    `INSERT INTO loremaster.guest_sessions
       (id, guest_id, token_hash, csrf_hash, expires_at)
     VALUES ($1::uuid, $2::uuid,
             decode(repeat(replace($1::text, '-', ''), 2), 'hex'),
             decode(repeat(replace($2::text, '-', ''), 2), 'hex'),
             clock_timestamp() + interval '29 days')`,
    [sessionId, guestId],
  )
  return { guestId, sessionId }
}

async function createAttempt(
  publishedCase: PublishedCase,
  guestId: string,
  state: 'ACTIVE' | 'SOLVED' | 'GIVEN_UP' = 'ACTIVE',
): Promise<string> {
  const attemptId = randomUUID()
  await db.query(
    `INSERT INTO loremaster.attempts
       (id, guest_id, revision_id, slot_id, state, terminal_at)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $5 = 'ACTIVE' THEN NULL ELSE clock_timestamp() END)`,
    [attemptId, guestId, publishedCase.revisionId, publishedCase.slotId, state],
  )
  return attemptId
}

async function createExpiredReceiptFixture(slotId: string): Promise<{
  attemptId: string
  guestId: string
  sessionId: string
}> {
  const publishedCase = await createPublishedCase(slotId)
  const { guestId, sessionId } = await createGuest()
  const attemptId = await createAttempt(publishedCase, guestId)
  await db.query(
    `INSERT INTO loremaster.command_receipts
       (id, guest_id, session_id, idempotency_key, command_fingerprint,
        command_kind, outcome_code, attempt_id, committed_version)
     VALUES ($1, $2, $3, $4, decode(repeat('88', 32), 'hex'),
             'START', 'STARTED', $5, 0)`,
    [randomUUID(), guestId, sessionId, `receipt-${slotId}`, attemptId],
  )
  const expiry = await db.query<{ expired: boolean }>(
    `UPDATE loremaster.guest_sessions
     SET expires_at = created_at + interval '1 microsecond'
     WHERE id = $1
     RETURNING expires_at < clock_timestamp() AS expired`,
    [sessionId],
  )
  expect(expiry.rows[0]?.expired).toBe(true)
  return { attemptId, guestId, sessionId }
}

describe('S4.3a database toolchain', () => {
  it('applies the migration once and restricts DDL to migration credentials', async () => {
    const migration = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.loremaster_schema_migrations',
    )
    expect(migration.rows[0]?.count).toBe('4')

    const privileges = await db.query<{
      importer_create: boolean
      runtime_delete_attempts: boolean
      runtime_delete_receipts: boolean
      runtime_delete_sessions: boolean
      runtime_update_finalizations: boolean
      runtime_create: boolean
    }>(`SELECT
      has_schema_privilege('loremaster_importer', 'loremaster', 'CREATE') AS importer_create,
      has_schema_privilege('loremaster_runtime', 'loremaster', 'CREATE') AS runtime_create,
      has_table_privilege('loremaster_runtime', 'loremaster.attempts', 'DELETE') AS runtime_delete_attempts,
      has_table_privilege('loremaster_runtime', 'loremaster.command_receipts', 'DELETE') AS runtime_delete_receipts,
      has_table_privilege('loremaster_runtime', 'loremaster.guest_sessions', 'DELETE') AS runtime_delete_sessions,
      has_table_privilege('loremaster_runtime', 'loremaster.attempt_finalizations', 'UPDATE') AS runtime_update_finalizations`)
    expect(privileges.rows[0]).toEqual({
      importer_create: false,
      runtime_delete_attempts: false,
      runtime_delete_receipts: false,
      runtime_delete_sessions: false,
      runtime_update_finalizations: false,
      runtime_create: false,
    })

    const client = await db.connect()
    try {
      await client.query('SET ROLE loremaster_runtime')
      await expect(
        client.query(
          'CREATE TABLE loremaster.runtime_must_not_create (id int)',
        ),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('RESET ROLE')
      client.release()
    }
  })
})

describe('S4.3b immutable content revisions', () => {
  it('accepts adjacent exact UTC days and rejects malformed or overlapping windows', async () => {
    await createPublishedCase('2040-01-01')
    await createPublishedCase('2040-01-02')

    const packId = randomUUID()
    await db.query(
      'INSERT INTO loremaster.content_packs (id, stable_key) VALUES ($1, $2)',
      [packId, `pack_${randomUUID().replaceAll('-', '')}`],
    )
    await expect(
      db.query(
        `INSERT INTO loremaster.case_revisions
           (id, pack_id, revision_number, slot_id, opens_at, closes_at, briefing)
         VALUES ($1, $2, 1, '2040-01-03', '2040-01-03T01:00:00Z',
                 '2040-01-04T01:00:00Z', 'briefing')`,
        [randomUUID(), packId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    await expect(createPublishedCase('2040-01-01')).rejects.toMatchObject({
      code: '23P01',
    })
  })

  it('freezes the revision and every child row after publication', async () => {
    const publishedCase = await createPublishedCase('2040-02-01')
    const actions = [
      () =>
        db.query(
          `INSERT INTO loremaster.entity_aliases (revision_id, entity_id, alias)
         VALUES ($1, $2, 'new alias')`,
          [publishedCase.revisionId, publishedCase.entityId],
        ),
      () =>
        db.query(
          `UPDATE loremaster.case_entities SET role = 'changed' WHERE revision_id = $1`,
          [publishedCase.revisionId],
        ),
      () =>
        db.query(
          `DELETE FROM loremaster.revision_regions WHERE revision_id = $1`,
          [publishedCase.revisionId],
        ),
      () =>
        db.query(
          `UPDATE loremaster.case_evidence SET evidence_text = 'changed' WHERE revision_id = $1`,
          [publishedCase.revisionId],
        ),
      () =>
        db.query(
          `INSERT INTO loremaster.case_sources
           (revision_id, source_order, source_id, citation)
         VALUES ($1, 1, 'source', 'citation')`,
          [publishedCase.revisionId],
        ),
    ]
    for (const action of actions) {
      await expect(action()).rejects.toMatchObject({ code: '55000' })
    }
    await expect(
      db.query('DELETE FROM loremaster.case_revisions WHERE id = $1', [
        publishedCase.revisionId,
      ]),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('serializes publication against concurrent child writes', async () => {
    const packId = randomUUID()
    const revisionId = randomUUID()
    const entityId = randomUUID()
    await db.query(
      'INSERT INTO loremaster.content_packs (id, stable_key) VALUES ($1, $2)',
      [packId, `pack_${randomUUID().replaceAll('-', '')}`],
    )
    await db.query(
      `INSERT INTO loremaster.case_revisions
         (id, pack_id, revision_number, slot_id, opens_at, closes_at, briefing,
          case_key, title, author, provenance, content_version)
       VALUES ($1, $2, 1, '2040-03-01', '2040-03-01T00:00:00Z',
               '2040-03-02T00:00:00Z', 'briefing', 'test-case', 'Test case',
               'Test author', 'ORIGINAL_AUTHORED', '1.0.0')`,
      [revisionId, packId],
    )
    await db.query(
      `INSERT INTO loremaster.case_entities
         (revision_id, entity_id, public_id, canonical_name, role)
       VALUES ($1, $2, $3, 'Entity', 'suspect')`,
      [revisionId, entityId, `entity_${entityId.replaceAll('-', '')}`],
    )
    for (let order = 1; order <= 4; order += 1) {
      await db.query(
        `INSERT INTO loremaster.case_evidence
           (revision_id, evidence_order, evidence_text, explanation)
         VALUES ($1, $2, 'evidence', 'explanation')`,
        [revisionId, order],
      )
    }

    const publisher = await db.connect()
    const writer = await db.connect()
    try {
      await publisher.query('BEGIN')
      await publisher.query(
        `UPDATE loremaster.case_revisions
         SET answer_entity_id = $2, status = 'PUBLISHED', published_at = clock_timestamp()
         WHERE id = $1`,
        [revisionId, entityId],
      )

      let settled = false
      const pendingWrite = writer
        .query(
          `INSERT INTO loremaster.entity_aliases (revision_id, entity_id, alias)
           VALUES ($1, $2, 'late alias')`,
          [revisionId, entityId],
        )
        .then(
          () => ({ ok: true as const, error: undefined }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          settled = true
        })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(settled).toBe(false)
      await publisher.query('COMMIT')
      const writeResult = await pendingWrite
      expect(writeResult.ok).toBe(false)
      expect(writeResult.error).toMatchObject({ code: '55000' })
    } finally {
      await publisher.query('ROLLBACK').catch(() => undefined)
      publisher.release()
      writer.release()
    }
  })
})

describe('S4.3c guest, attempt, guess, and receipt constraints', () => {
  it('enforces identity, reachable counters, one start, and fixed fingerprints', async () => {
    const publishedCase = await createPublishedCase('2040-04-01')
    const { guestId, sessionId } = await createGuest()
    const attemptId = await createAttempt(publishedCase, guestId)
    await expect(createAttempt(publishedCase, guestId)).rejects.toMatchObject({
      code: '23505',
    })

    await expect(
      db.query(
        `UPDATE loremaster.attempts
         SET evidence_level = 1, wrong_guesses_at_level = 0, total_wrong_guesses = 4
         WHERE guest_id = $1 AND slot_id = $2`,
        [guestId, publishedCase.slotId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    await expect(
      db.query(
        `INSERT INTO loremaster.command_receipts
           (id, guest_id, session_id, idempotency_key, command_fingerprint,
            command_kind, outcome_code)
         VALUES ($1, $2, $3, 'key', decode('00', 'hex'), 'GUESS', 'ACCEPTED')`,
        [randomUUID(), guestId, sessionId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    await db.query(
      `INSERT INTO loremaster.command_receipts
         (id, guest_id, session_id, idempotency_key, command_fingerprint,
          command_kind, outcome_code, attempt_id, committed_version)
       VALUES ($1, $2, $3, 'key', decode(repeat('33', 32), 'hex'),
               'GUESS', 'WRONG', $4, 0)`,
      [randomUUID(), guestId, sessionId, attemptId],
    )
    await expect(
      db.query(
        `UPDATE loremaster.command_receipts
         SET outcome_code = 'CHANGED' WHERE guest_id = $1 AND idempotency_key = 'key'`,
        [guestId],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      db.query(
        `INSERT INTO loremaster.command_receipts
           (id, guest_id, session_id, idempotency_key, command_fingerprint,
            command_kind, outcome_code, attempt_id, committed_version)
         VALUES ($1, $2, $3, 'key', decode(repeat('44', 32), 'hex'),
                 'REVEAL', 'REVEALED', $4, 0)`,
        [randomUUID(), guestId, sessionId, attemptId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      db.query('DELETE FROM loremaster.command_receipts WHERE guest_id = $1', [
        guestId,
      ]),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('allows attempts to reference published revisions only', async () => {
    const packId = randomUUID()
    const revisionId = randomUUID()
    const { guestId } = await createGuest()
    await db.query(
      'INSERT INTO loremaster.content_packs (id, stable_key) VALUES ($1, $2)',
      [packId, `pack_${randomUUID().replaceAll('-', '')}`],
    )
    await db.query(
      `INSERT INTO loremaster.case_revisions
         (id, pack_id, revision_number, slot_id, opens_at, closes_at, briefing)
       VALUES ($1, $2, 1, '2040-04-02', '2040-04-02T00:00:00Z',
               '2040-04-03T00:00:00Z', 'draft')`,
      [revisionId, packId],
    )
    await expect(
      db.query(
        `INSERT INTO loremaster.attempts (id, guest_id, revision_id, slot_id)
         VALUES ($1, $2, $3, '2040-04-02')`,
        [randomUUID(), guestId, revisionId],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('permits receipt cleanup only after expiry and prevents identity resurrection', async () => {
    const guestId = randomUUID()
    const sessionId = randomUUID()
    const publishedCase = await createPublishedCase('2040-04-04')
    await db.query(
      'INSERT INTO loremaster.guests (id, pseudonym) VALUES ($1, $2)',
      [guestId, 'Expired Guest'],
    )
    await db.query(
      `INSERT INTO loremaster.guest_sessions
         (id, guest_id, token_hash, csrf_hash, created_at, expires_at)
       VALUES ($1, $2, decode(repeat('55', 32), 'hex'), decode(repeat('66', 32), 'hex'),
               clock_timestamp(), clock_timestamp() + interval '1 day')`,
      [sessionId, guestId],
    )
    const attemptId = await createAttempt(publishedCase, guestId)
    await db.query(
      `INSERT INTO loremaster.command_receipts
         (id, guest_id, session_id, idempotency_key, command_fingerprint,
          command_kind, outcome_code, attempt_id, committed_version)
       VALUES ($1, $2, $3, 'expired-key', decode(repeat('77', 32), 'hex'),
               'START', 'STARTED', $4, 0)`,
      [randomUUID(), guestId, sessionId, attemptId],
    )
    await expect(
      db.query('DELETE FROM loremaster.command_receipts WHERE guest_id = $1', [
        guestId,
      ]),
    ).rejects.toMatchObject({ code: '55000' })
    const expiry = await db.query<{ expired: boolean }>(
      `UPDATE loremaster.guest_sessions
       SET expires_at = created_at + interval '1 microsecond'
       WHERE id = $1
       RETURNING expires_at < clock_timestamp() AS expired`,
      [sessionId],
    )
    expect(expiry.rows[0]?.expired).toBe(true)
    const deleted = await db.query(
      'DELETE FROM loremaster.command_receipts WHERE guest_id = $1',
      [guestId],
    )
    expect(deleted.rowCount).toBe(1)
    await expect(
      db.query(
        `INSERT INTO loremaster.guest_sessions
           (id, guest_id, token_hash, csrf_hash, expires_at)
         VALUES ($1::uuid, $2::uuid,
                 decode(repeat(replace($1::text, '-', ''), 2), 'hex'),
                 decode(repeat(replace($2::text, '-', ''), 2), 'hex'),
                 clock_timestamp() + interval '1 day')`,
        [randomUUID(), guestId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('keeps retained session identity and creation time immutable', async () => {
    const { sessionId } = await createGuest()

    await expect(
      db.query('UPDATE loremaster.guest_sessions SET id = $1 WHERE id = $2', [
        randomUUID(),
        sessionId,
      ]),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      db.query(
        `UPDATE loremaster.guest_sessions
         SET created_at = created_at - interval '1 second'
         WHERE id = $1`,
        [sessionId],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it.each([
    ['a concurrent session insert', '2040-04-05', 'INSERT'],
    ['a concurrent session expiry extension', '2040-04-06', 'UPDATE'],
  ] as const)(
    'rejects %s after cleanup wins the guest lock',
    async (_label, fixtureSlot, operation) => {
      const fixture = await createExpiredReceiptFixture(fixtureSlot)
      const sessionWriter = await db.connect()
      const receiptCleaner = await db.connect()
      const concurrentSessionId = randomUUID()
      try {
        await receiptCleaner.query('BEGIN')
        await receiptCleaner.query(
          'DELETE FROM loremaster.command_receipts WHERE guest_id = $1',
          [fixture.guestId],
        )

        let settled = false
        const pendingSessionWrite = (
          operation === 'INSERT'
            ? sessionWriter.query(
                `INSERT INTO loremaster.guest_sessions
               (id, guest_id, token_hash, csrf_hash, expires_at)
             VALUES ($1::uuid, $2::uuid,
                     decode(repeat(replace($1::text, '-', ''), 2), 'hex'),
                     decode(repeat(replace($2::text, '-', ''), 2), 'hex'),
                     clock_timestamp() + interval '1 day')`,
                [concurrentSessionId, fixture.guestId],
              )
            : sessionWriter.query(
                `UPDATE loremaster.guest_sessions
             SET expires_at = clock_timestamp() + interval '1 day'
             WHERE id = $1`,
                [fixture.sessionId],
              )
        )
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            settled = true
          })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(settled).toBe(false)
        await receiptCleaner.query('COMMIT')
        const result = await pendingSessionWrite
        expect(result.error).toMatchObject({
          code: operation === 'INSERT' ? '23505' : '55000',
        })
      } finally {
        await receiptCleaner.query('ROLLBACK').catch(() => undefined)
        sessionWriter.release()
        receiptCleaner.release()
      }
    },
  )
})

describe('S4.3d exactly-once effect ledgers', () => {
  it('uses unique constraints to arbitrate concurrent finalization', async () => {
    const publishedCase = await createPublishedCase('2040-05-02')
    const { guestId } = await createGuest()
    const attemptId = await createAttempt(publishedCase, guestId, 'SOLVED')
    const statement = `INSERT INTO loremaster.attempt_finalizations
      (attempt_id, guest_id, slot_id, outcome, score)
      VALUES ($1, $2, $3, 'SOLVED', 100)`
    const values = [attemptId, guestId, publishedCase.slotId]
    const results = await Promise.allSettled([
      db.query(statement, values),
      db.query(statement, values),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: '23505' })
  })

  it('deduplicates finalization, participation, knowledge, and leaderboard effects', async () => {
    const publishedCase = await createPublishedCase('2040-05-01')
    const { guestId } = await createGuest()
    const attemptId = await createAttempt(publishedCase, guestId, 'SOLVED')
    await db.query(
      `INSERT INTO loremaster.attempt_finalizations
         (attempt_id, guest_id, slot_id, outcome, score)
       VALUES ($1, $2, $3, 'SOLVED', 0)`,
      [attemptId, guestId, publishedCase.slotId],
    )
    await expect(
      db.query(
        `INSERT INTO loremaster.attempt_finalizations
           (attempt_id, guest_id, slot_id, outcome, score)
         VALUES ($1, $2, $3, 'SOLVED', 1)`,
        [attemptId, guestId, publishedCase.slotId],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await db.query(
      `INSERT INTO loremaster.participation_days (guest_id, utc_day)
       VALUES ($1, $2)`,
      [guestId, publishedCase.slotId],
    )
    await expect(
      db.query(
        `INSERT INTO loremaster.participation_days (guest_id, utc_day)
         VALUES ($1, $2)`,
        [guestId, publishedCase.slotId],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await db.query(
      `INSERT INTO loremaster.knowledge_contributions
         (attempt_id, revision_id, guest_id, slot_id, outcome, region_id,
          alpha_delta, beta_delta)
       VALUES ($1, $2, $3, $4, 'SOLVED', $5, 0.85, 0.15)`,
      [
        attemptId,
        publishedCase.revisionId,
        guestId,
        publishedCase.slotId,
        publishedCase.regionId,
      ],
    )
    await expect(
      db.query(
        `INSERT INTO loremaster.knowledge_contributions
           (attempt_id, revision_id, guest_id, slot_id, outcome, region_id,
            alpha_delta, beta_delta)
         VALUES ($1, $2, $3, $4, 'SOLVED', $5, 0.80, 0.20)`,
        [
          attemptId,
          publishedCase.revisionId,
          guestId,
          publishedCase.slotId,
          publishedCase.regionId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await db.query(
      `INSERT INTO loremaster.regional_knowledge
         (guest_id, region_id, alpha, beta, sample_count)
       VALUES ($1, $2, 2.85, 2.15, 1)`,
      [guestId, publishedCase.regionId],
    )
    const knowledge = await db.query<{ alpha: string; beta: string }>(
      `SELECT alpha::text, beta::text FROM loremaster.regional_knowledge
       WHERE guest_id = $1 AND region_id = $2`,
      [guestId, publishedCase.regionId],
    )
    expect(knowledge.rows[0]).toEqual({ alpha: '2.85', beta: '2.15' })

    const leaderboardValues = [
      attemptId,
      guestId,
      publishedCase.slotId,
      `Guest ${guestId.slice(0, 8)}`,
    ]
    await db.query(
      `INSERT INTO loremaster.leaderboard_entries
         (attempt_id, guest_id, slot_id, pseudonym, evidence_level,
          total_wrong_guesses, elapsed_ms, score)
       VALUES ($1, $2, $3, $4, 0, 0, 30000, 0)`,
      leaderboardValues,
    )
    await expect(
      db.query(
        `INSERT INTO loremaster.leaderboard_entries
           (attempt_id, guest_id, slot_id, pseudonym, evidence_level,
            total_wrong_guesses, elapsed_ms, score)
         VALUES ($1, $2, $3, $4, 0, 0, 30000, 0)`,
        leaderboardValues,
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('rejects effects that contradict the authoritative attempt outcome', async () => {
    const publishedCase = await createPublishedCase('2040-06-01')
    const { guestId } = await createGuest()
    const attemptId = await createAttempt(publishedCase, guestId, 'GIVEN_UP')
    await expect(
      db.query(
        `INSERT INTO loremaster.attempt_finalizations
           (attempt_id, guest_id, slot_id, outcome, score)
         VALUES ($1, $2, $3, 'SOLVED', 100)`,
        [attemptId, guestId, publishedCase.slotId],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })
})
