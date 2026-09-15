import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asterQuayContentPack } from '../../packages/database/dist/content/fixtures/aster-quay.js'
import { importContentPack } from '../../packages/database/dist/content/index.js'
import {
  executeGameplayCommand,
  readAttemptSuggestions,
  readCurrentCase,
  readDailyLeaderboard,
  readDailyLeaderboardPage,
  readOwnedAttempt,
  readProfile,
  startCurrentAttempt,
} from '../../packages/database/dist/gameplay/index.js'
import {
  closeDatabase,
  database,
  migrateToLatest,
  type Database,
} from '../../packages/database/dist/migrate.js'
import { scoreSolvedAttempt } from '../../packages/domain/dist/index.js'

const connectionString = process.env.LOREMASTER_TEST_DATABASE_URL
if (connectionString === undefined) {
  throw new Error(
    'LOREMASTER_TEST_DATABASE_URL is required; run this suite with `pnpm test:database`',
  )
}

let db: Database
let revisionId: string
let slotId: string

beforeAll(async () => {
  db = database(connectionString)
  slotId = (
    await db.query<{ day: string }>(
      "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day",
    )
  ).rows[0]!.day
  const closes = new Date(`${slotId}T00:00:00.000Z`)
  closes.setUTCDate(closes.getUTCDate() + 1)
  const marker = randomUUID().replaceAll('-', '')
  const result = await importContentPack(
    db,
    {
      ...structuredClone(asterQuayContentPack),
      caseId: `gameplay-${marker}`,
      stableKey: `gameplay-${marker}`,
      slotId,
      opensAt: `${slotId}T00:00:00.000Z`,
      closesAt: closes.toISOString(),
    },
    'PUBLISH',
  )
  if (!result.ok)
    throw new Error(`fixture publication failed: ${JSON.stringify(result)}`)
  revisionId = result.revisionId
})

afterAll(async () => closeDatabase(db))

async function identity(target = db) {
  const guestId = randomUUID()
  const sessionId = randomUUID()
  await target.query(
    'INSERT INTO loremaster.guests (id,pseudonym) VALUES ($1,$2)',
    [guestId, `Guest ${guestId.slice(0, 8)}`],
  )
  await target.query(
    `INSERT INTO loremaster.guest_sessions (id,guest_id,token_hash,csrf_hash,expires_at)
     VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 day')`,
    [sessionId, guestId, randomBytes(32), randomBytes(32)],
  )
  return { guestId, sessionId }
}

async function publishHistorical(slot: string): Promise<string> {
  const close = new Date(`${slot}T00:00:00.000Z`)
  close.setUTCDate(close.getUTCDate() + 1)
  const marker = randomUUID().replaceAll('-', '')
  const result = await importContentPack(
    db,
    {
      ...structuredClone(asterQuayContentPack),
      caseId: `case-${marker}`,
      stableKey: `pack-${marker}`,
      slotId: slot,
      opensAt: `${slot}T00:00:00.000Z`,
      closesAt: close.toISOString(),
    },
    'PUBLISH',
  )
  if (!result.ok) throw new Error(`fixture publication failed for ${slot}`)
  return result.revisionId
}

async function answerAndWrong(revision = revisionId) {
  const result = await db.query<{ answer: string; wrong: string }>(
    `SELECT revision.answer_entity_id::text AS answer,
       (SELECT entity_id::text FROM loremaster.case_entities
        WHERE revision_id=revision.id AND entity_id<>revision.answer_entity_id
        ORDER BY entity_id LIMIT 1) AS wrong
     FROM loremaster.case_revisions revision WHERE revision.id=$1`,
    [revision],
  )
  return result.rows[0]!
}

async function seedActiveAttempt(
  guestId: string,
  options: {
    evidenceLevel?: number
    revision?: string
    slot?: string
    startedAt?: string
    totalWrongGuesses?: number
    wrongGuessesAtLevel?: number
  } = {},
) {
  const attemptId = randomUUID()
  await db.query(
    `INSERT INTO loremaster.attempts
      (id,guest_id,revision_id,slot_id,evidence_level,wrong_guesses_at_level,
       total_wrong_guesses,started_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,clock_timestamp()),
       COALESCE($8,clock_timestamp()))`,
    [
      attemptId,
      guestId,
      options.revision ?? revisionId,
      options.slot ?? slotId,
      options.evidenceLevel ?? 0,
      options.wrongGuessesAtLevel ?? 0,
      options.totalWrongGuesses ?? 0,
      options.startedAt ?? null,
    ],
  )
  return attemptId
}

describe('S4.6 gameplay repository', () => {
  it('returns NO_CASE and creates no attempt or effects in an empty migrated database (T01/T25)', async () => {
    const databaseName = `loremaster_nocase_${randomUUID().replaceAll('-', '')}`
    await db.query(`CREATE DATABASE ${databaseName}`)
    const isolatedUrl = new URL(connectionString)
    isolatedUrl.pathname = `/${databaseName}`
    const isolated = database(isolatedUrl.toString())
    try {
      await migrateToLatest(isolated)
      const actor = await identity(isolated)
      expect(await readCurrentCase(isolated, actor.guestId)).toEqual({
        view: 'NO_CASE',
      })
      expect(
        await startCurrentAttempt(isolated, {
          ...actor,
          idempotencyKey: 'no-case',
        }),
      ).toEqual({ ok: false, code: 'NO_CASE' })
      const counts = await isolated.query<{
        attempts: string
        effects: string
        receipts: string
      }>(
        `SELECT
          (SELECT count(*) FROM loremaster.attempts)::text AS attempts,
          (SELECT count(*) FROM loremaster.attempt_finalizations)::text AS effects,
          (SELECT count(*) FROM loremaster.command_receipts)::text AS receipts`,
      )
      expect(counts.rows[0]).toEqual({
        attempts: '0',
        effects: '0',
        receipts: '0',
      })
    } finally {
      await closeDatabase(isolated)
      await db.query(`DROP DATABASE ${databaseName}`)
    }
  }, 15_000)

  it('reads without starting, then starts and refreshes exactly one owned attempt (T02/T03/B13)', async () => {
    const actor = await identity()
    expect(await readCurrentCase(db, actor.guestId)).toMatchObject({
      view: 'NOT_STARTED',
      slotId,
    })

    const first = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-once',
    })
    const replay = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-once',
    })
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      projection: { state: 'ACTIVE', evidence: [] },
    })
    expect(replay).toMatchObject({ ok: true, replayed: true })
    if (!first.ok || !replay.ok) throw new Error('start unexpectedly rejected')
    expect(first.projection.suggestions.map((item) => item.entityId)).toContain(
      'mira-vale',
    )
    expect(replay.projection.attemptId).toBe(first.projection.attemptId)
    expect(replay.projection.startedAt).toBe(first.projection.startedAt)
    expect(Date.parse(first.projection.startedAt)).toBeLessThan(
      Date.parse(first.projection.closesAt),
    )
    expect(first.projection).not.toHaveProperty('answer')
    expect(JSON.stringify(first.projection)).not.toContain(
      asterQuayContentPack.evidence[2].text,
    )
  })

  it('commits one wrong guess for an exact retry and rejects stale competing work (T17-T20)', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-race',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const projection = started.projection
    const answer = await db.query<{ answer: string }>(
      'SELECT answer_entity_id::text AS answer FROM loremaster.case_revisions WHERE id=$1',
      [revisionId],
    )
    const wrong = projection.suggestions.find(
      (item) => item.entityId !== answer.rows[0]!.answer,
    )!
    const command = {
      ...actor,
      attemptId: projection.attemptId,
      expectedVersion: 0,
      idempotencyKey: 'wrong-once',
      command: { kind: 'GUESS' as const, entityId: wrong.entityId },
    }
    const first = await executeGameplayCommand(db, command)
    const replay = await executeGameplayCommand(db, command)
    const stale = await executeGameplayCommand(db, {
      ...command,
      idempotencyKey: 'stale',
      command: { kind: 'REVEAL' },
    })
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      outcomeCode: 'WRONG',
      projection: { totalWrongGuesses: 1, version: 1 },
    })
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      projection: { totalWrongGuesses: 1, version: 1 },
    })
    expect(stale).toMatchObject({
      ok: false,
      code: 'STALE_VERSION',
      projection: { totalWrongGuesses: 1, version: 1 },
    })
  })

  it('solves atomically and exposes exactly-once profile, knowledge, and leaderboard effects (T04)', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-solve',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const answer = await db.query<{ answer: string }>(
      'SELECT answer_entity_id::text AS answer FROM loremaster.case_revisions WHERE id=$1',
      [revisionId],
    )
    const command = {
      ...actor,
      attemptId: started.projection.attemptId,
      expectedVersion: 0,
      idempotencyKey: 'solve',
      command: { kind: 'GUESS' as const, entityId: answer.rows[0]!.answer },
    }
    const solved = await executeGameplayCommand(db, command)
    const replay = await executeGameplayCommand(db, command)
    expect(solved).toMatchObject({
      ok: true,
      replayed: false,
      outcomeCode: 'CORRECT',
      projection: { state: 'SOLVED', version: 1 },
    })
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      projection: { state: 'SOLVED', version: 1 },
    })
    expect(
      await readOwnedAttempt(db, actor.guestId, started.projection.attemptId),
    ).toMatchObject({ state: 'SOLVED' })
    expect(await readProfile(db, actor.guestId)).toMatchObject({
      solvedCount: 1,
      failedCount: 0,
      accuracyPercentage: 100,
    })
    expect(await readDailyLeaderboard(db, slotId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptId: started.projection.attemptId,
          rank: expect.any(Number),
        }),
      ]),
    )
    const effects = await db.query<{
      finalizations: string
      contributions: string
      elapsed_ms: string
      participation: string
      score: number
    }>(
      `SELECT (SELECT count(*) FROM loremaster.attempt_finalizations WHERE attempt_id=$1)::text AS finalizations,
              (SELECT count(*) FROM loremaster.knowledge_contributions WHERE attempt_id=$1)::text AS contributions,
              (SELECT count(*) FROM loremaster.participation_days WHERE guest_id=$2)::text AS participation,
              leaderboard.elapsed_ms::text, leaderboard.score
       FROM loremaster.leaderboard_entries leaderboard WHERE leaderboard.attempt_id=$1`,
      [started.projection.attemptId, actor.guestId],
    )
    const persisted = effects.rows[0]!
    expect(persisted).toMatchObject({
      finalizations: '1',
      contributions: '1',
      participation: '1',
      score: 1_350,
    })
    expect(persisted.score).toBe(
      scoreSolvedAttempt(
        {
          state: 'SOLVED',
          evidenceLevel: 0,
          wrongGuessesAtLevel: 0,
          totalWrongGuesses: 0,
        },
        Number(persisted.elapsed_ms),
      ).score,
    )
  })

  it('does not disclose attempts or receipts across guests (T24)', async () => {
    const owner = await identity()
    const stranger = await identity()
    const started = await startCurrentAttempt(db, {
      ...owner,
      idempotencyKey: 'owner-start',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    expect(
      await readOwnedAttempt(
        db,
        stranger.guestId,
        started.projection.attemptId,
      ),
    ).toBeUndefined()
    expect(
      await executeGameplayCommand(db, {
        ...stranger,
        attemptId: started.projection.attemptId,
        expectedVersion: 0,
        idempotencyKey: 'owner-start',
        command: { kind: 'GIVE_UP' },
      }),
    ).toEqual({ ok: false, code: 'UNKNOWN_ATTEMPT' })
  })

  it('serializes same-version commands so only one can commit (T19)', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-concurrent',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const request = {
      ...actor,
      attemptId: started.projection.attemptId,
      expectedVersion: 0,
    }
    const results = await Promise.all([
      executeGameplayCommand(db, {
        ...request,
        idempotencyKey: 'race-reveal',
        command: { kind: 'REVEAL' },
      }),
      executeGameplayCommand(db, {
        ...request,
        idempotencyKey: 'race-give-up',
        command: { kind: 'GIVE_UP' },
      }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const rejected = results.find((result) => !result.ok)
    expect(rejected).toBeDefined()
    if (rejected?.ok === false) {
      expect(['STALE_VERSION', 'TERMINAL_ATTEMPT']).toContain(rejected.code)
    }
  })

  it('serializes concurrent starts to one attempt while recording each successful key', async () => {
    const actor = await identity()
    const results = await Promise.all([
      startCurrentAttempt(db, {
        ...actor,
        idempotencyKey: 'concurrent-start-a',
      }),
      startCurrentAttempt(db, {
        ...actor,
        idempotencyKey: 'concurrent-start-b',
      }),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    if (!results[0]?.ok || !results[1]?.ok)
      throw new Error('concurrent start unexpectedly rejected')
    expect(results[0].projection.attemptId).toBe(
      results[1].projection.attemptId,
    )
    const persisted = await db.query<{ attempts: string; receipts: string }>(
      `SELECT
        (SELECT count(*) FROM loremaster.attempts WHERE guest_id=$1)::text AS attempts,
        (SELECT count(*) FROM loremaster.command_receipts
         WHERE guest_id=$1 AND command_kind='START')::text AS receipts`,
      [actor.guestId],
    )
    expect(persisted.rows[0]).toEqual({ attempts: '1', receipts: '2' })
  })

  it('applies repeated wrong guesses and every automatic-unlock boundary (T05/T06/T08/T20)', async () => {
    const { wrong } = await answerAndWrong()
    for (const level of [0, 1, 2, 3] as const) {
      const actor = await identity()
      const attemptId = await seedActiveAttempt(actor.guestId, {
        evidenceLevel: level,
        wrongGuessesAtLevel: 2,
        totalWrongGuesses: level * 3 + 2,
      })
      const result = await executeGameplayCommand(db, {
        ...actor,
        attemptId,
        expectedVersion: 0,
        idempotencyKey: `unlock-${level}`,
        command: { kind: 'GUESS', entityId: wrong },
      })
      expect(result).toMatchObject({
        ok: true,
        projection: {
          state: 'ACTIVE',
          evidenceLevel: level + 1,
          wrongGuessesAtLevel: 0,
          totalWrongGuesses: level * 3 + 3,
        },
      })
    }

    const actor = await identity()
    const attemptId = await seedActiveAttempt(actor.guestId, {
      evidenceLevel: 2,
      totalWrongGuesses: 3,
    })
    for (let version = 0; version < 2; version += 1) {
      const result = await executeGameplayCommand(db, {
        ...actor,
        attemptId,
        expectedVersion: version,
        idempotencyKey: `repeat-wrong-${version}`,
        command: { kind: 'GUESS', entityId: wrong },
      })
      expect(result).toMatchObject({
        ok: true,
        projection: {
          evidenceLevel: 2,
          totalWrongGuesses: 4 + version,
          wrongGuessesAtLevel: 1 + version,
        },
      })
    }

    const levelFourActor = await identity()
    const levelFourId = await seedActiveAttempt(levelFourActor.guestId, {
      evidenceLevel: 4,
      wrongGuessesAtLevel: 1,
      totalWrongGuesses: 13,
    })
    expect(
      await executeGameplayCommand(db, {
        ...levelFourActor,
        attemptId: levelFourId,
        expectedVersion: 0,
        idempotencyKey: 'level-four-second-wrong',
        command: { kind: 'GUESS', entityId: wrong },
      }),
    ).toMatchObject({
      ok: true,
      projection: {
        state: 'ACTIVE',
        evidenceLevel: 4,
        wrongGuessesAtLevel: 2,
        totalWrongGuesses: 14,
      },
    })
  })

  it('exhausts on the fifteenth wrong guess and finalizes once (T09)', async () => {
    const actor = await identity()
    const attemptId = await seedActiveAttempt(actor.guestId, {
      evidenceLevel: 4,
      wrongGuessesAtLevel: 2,
      totalWrongGuesses: 14,
    })
    const { wrong } = await answerAndWrong()
    const exhausted = await executeGameplayCommand(db, {
      ...actor,
      attemptId,
      expectedVersion: 0,
      idempotencyKey: 'exhaust',
      command: { kind: 'GUESS', entityId: wrong },
    })
    expect(exhausted).toMatchObject({
      ok: true,
      projection: { state: 'EXHAUSTED', totalWrongGuesses: 15 },
    })
    expect(await readProfile(db, actor.guestId)).toMatchObject({
      solvedCount: 0,
      failedCount: 1,
    })
  })

  it('rejects an unknown entity without writes or a consumed key (T16)', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-unknown-entity',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const result = await executeGameplayCommand(db, {
      ...actor,
      attemptId: started.projection.attemptId,
      expectedVersion: 0,
      idempotencyKey: 'unknown-entity',
      command: { kind: 'GUESS', entityId: randomUUID() },
    })
    expect(result).toEqual({ ok: false, code: 'UNKNOWN_ENTITY' })
    const state = await db.query<{
      guesses: string
      receipts: string
      version: number
    }>(
      `SELECT attempt.version,
        (SELECT count(*) FROM loremaster.guesses WHERE attempt_id=attempt.id)::text AS guesses,
        (SELECT count(*) FROM loremaster.command_receipts
         WHERE guest_id=$2 AND idempotency_key='unknown-entity')::text AS receipts
       FROM loremaster.attempts attempt WHERE attempt.id=$1`,
      [started.projection.attemptId, actor.guestId],
    )
    expect(state.rows[0]).toEqual({ guesses: '0', receipts: '0', version: 0 })
  })

  it('scores an automatic-unlock solve and persists exact regional precision once (T21/B05/B06)', async () => {
    const actor = await identity()
    const attemptId = await seedActiveAttempt(actor.guestId, {
      wrongGuessesAtLevel: 2,
      totalWrongGuesses: 2,
    })
    await db.query(
      `UPDATE loremaster.attempts
       SET started_at=clock_timestamp()-interval '61000 milliseconds',
           updated_at=clock_timestamp()-interval '61000 milliseconds'
       WHERE id=$1`,
      [attemptId],
    )
    const { answer, wrong } = await answerAndWrong()
    expect(
      await executeGameplayCommand(db, {
        ...actor,
        attemptId,
        expectedVersion: 0,
        idempotencyKey: 'unlock-before-solve',
        command: { kind: 'GUESS', entityId: wrong },
      }),
    ).toMatchObject({
      ok: true,
      projection: { evidenceLevel: 1, totalWrongGuesses: 3 },
    })
    expect(
      await executeGameplayCommand(db, {
        ...actor,
        attemptId,
        expectedVersion: 1,
        idempotencyKey: 'solve-after-unlock',
        command: { kind: 'GUESS', entityId: answer },
      }),
    ).toMatchObject({ ok: true, projection: { state: 'SOLVED' } })
    const solvedEffects = await db.query<{
      alpha: string
      beta: string
      sample_count: number
      score: number
    }>(
      `SELECT knowledge.alpha::text, knowledge.beta::text,
              knowledge.sample_count, finalization.score
       FROM loremaster.regional_knowledge knowledge
       JOIN loremaster.attempt_finalizations finalization
         ON finalization.guest_id=knowledge.guest_id
       WHERE knowledge.guest_id=$1`,
      [actor.guestId],
    )
    expect(solvedEffects.rows[0]).toEqual({
      alpha: '2.70',
      beta: '2.30',
      sample_count: 1,
      score: 940,
    })

    const failedSlot = '2020-02-01'
    const failedRevision = await publishHistorical(failedSlot)
    const failedAttempt = await seedActiveAttempt(actor.guestId, {
      revision: failedRevision,
      slot: failedSlot,
      startedAt: '2020-02-01T00:00:00.000Z',
    })
    expect(
      await readOwnedAttempt(db, actor.guestId, failedAttempt),
    ).toMatchObject({ state: 'EXPIRED' })
    const profile = await readProfile(db, actor.guestId)
    expect(profile).toMatchObject({
      solvedCount: 1,
      failedCount: 1,
      accuracyPercentage: 50,
    })
    expect(
      profile?.regionalKnowledge.find(
        (knowledge) => knowledge.regionId === 'aster-quay',
      ),
    ).toMatchObject({
      alphaHundredths: 270,
      betaHundredths: 330,
      sampleCount: 2,
      displayPercentage: 45,
    })
  })

  it('keeps old attempts bound to their revision when the current slot is selected (T22)', async () => {
    const oldSlot = '2020-03-01'
    const oldRevision = await publishHistorical(oldSlot)
    const actor = await identity()
    const oldAttempt = await seedActiveAttempt(actor.guestId, {
      revision: oldRevision,
      slot: oldSlot,
      startedAt: '2020-03-01T00:00:00.000Z',
    })
    expect(await readCurrentCase(db, actor.guestId)).toMatchObject({
      view: 'NOT_STARTED',
      slotId,
    })
    const current = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-current-after-old',
    })
    if (!current.ok) throw new Error('current start unexpectedly rejected')
    expect(current.projection.attemptId).not.toBe(oldAttempt)
    expect(await readOwnedAttempt(db, actor.guestId, oldAttempt)).toMatchObject(
      {
        state: 'EXPIRED',
      },
    )
    expect(
      await executeGameplayCommand(db, {
        ...actor,
        attemptId: oldAttempt,
        expectedVersion: 1,
        idempotencyKey: 'mutate-old',
        command: { kind: 'GIVE_UP' },
      }),
    ).toMatchObject({ ok: false, code: 'TERMINAL_ATTEMPT' })
  })

  it('rejects an expired session before resolving a prior receipt', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'expire-before-replay',
    })
    expect(started).toMatchObject({ ok: true })
    const expiry = await db.query<{ expired: boolean }>(
      `UPDATE loremaster.guest_sessions
       SET expires_at=created_at+interval '1 microsecond' WHERE id=$1
       RETURNING expires_at < clock_timestamp() AS expired`,
      [actor.sessionId],
    )
    expect(expiry.rows[0]?.expired).toBe(true)
    expect(
      await startCurrentAttempt(db, {
        ...actor,
        idempotencyKey: 'expire-before-replay',
      }),
    ).toEqual({ ok: false, code: 'SESSION_EXPIRED' })
  })

  it('computes persisted multi-day streak and accuracy while omitting ACTIVE attempts (B08-B10)', async () => {
    const actor = await identity()
    for (const [index, state] of ['SOLVED', 'SOLVED', 'GIVEN_UP'].entries()) {
      const historicalSlot = `2019-01-0${index + 1}`
      const historicalRevision = await publishHistorical(historicalSlot)
      const attemptId = randomUUID()
      await db.query(
        `INSERT INTO loremaster.attempts
          (id,guest_id,revision_id,slot_id,state,started_at,updated_at,terminal_at)
         VALUES ($1,$2,$3,$4,$5,$4::date::timestamp AT TIME ZONE 'UTC',
           $4::date::timestamp AT TIME ZONE 'UTC',
           $4::date::timestamp AT TIME ZONE 'UTC')`,
        [attemptId, actor.guestId, historicalRevision, historicalSlot, state],
      )
      await db.query(
        `INSERT INTO loremaster.attempt_finalizations
          (attempt_id,guest_id,slot_id,outcome,score,finalized_at)
         VALUES ($1,$2,$3,$4,$5,$3::date::timestamp AT TIME ZONE 'UTC')`,
        [
          attemptId,
          actor.guestId,
          historicalSlot,
          state,
          state === 'SOLVED' ? 1 : 0,
        ],
      )
    }
    await seedActiveAttempt(actor.guestId)
    await db.query(
      `INSERT INTO loremaster.participation_days (guest_id,utc_day,first_guess_at)
       SELECT $1, day, day::timestamp AT TIME ZONE 'UTC'
       FROM (VALUES
         ((clock_timestamp() AT TIME ZONE 'UTC')::date - 1),
         ((clock_timestamp() AT TIME ZONE 'UTC')::date)
       ) AS participation(day)`,
      [actor.guestId],
    )
    expect(await readProfile(db, actor.guestId)).toMatchObject({
      currentStreak: 2,
      longestStreak: 2,
      solvedCount: 2,
      failedCount: 1,
      accuracyPercentage: 67,
    })
  })

  it('persists zero-score solves and ranks by performance with competition ties (B02-B04)', async () => {
    const leaderboardSlot = '2020-04-01'
    const leaderboardRevision = await publishHistorical(leaderboardSlot)
    const candidates = [
      {
        label: 'better-tier',
        evidence: 0,
        wrong: 2,
        elapsed: 301_000,
        score: 1_120,
      },
      {
        label: 'fast-lower-tier',
        evidence: 1,
        wrong: 0,
        elapsed: 1_000,
        score: 1_150,
      },
      { label: 'tie-a', evidence: 1, wrong: 0, elapsed: 42_000, score: 1_100 },
      { label: 'tie-b', evidence: 1, wrong: 0, elapsed: 42_000, score: 1_100 },
      {
        label: 'after-tie',
        evidence: 1,
        wrong: 0,
        elapsed: 42_001,
        score: 1_100,
      },
      {
        label: 'zero-score',
        evidence: 4,
        wrong: 14,
        elapsed: 301_000,
        score: 0,
      },
    ] as const
    const ids = new Map<string, string>()
    for (const candidate of candidates) {
      const actor = await identity()
      const attemptId = randomUUID()
      ids.set(candidate.label, attemptId)
      await db.query(
        `INSERT INTO loremaster.attempts
          (id,guest_id,revision_id,slot_id,state,evidence_level,
           wrong_guesses_at_level,total_wrong_guesses,started_at,updated_at,terminal_at)
         VALUES ($1,$2,$3,$4,'SOLVED',$5,$6,$7,
           $4::date::timestamp AT TIME ZONE 'UTC',
           $4::date::timestamp AT TIME ZONE 'UTC' + $8 * interval '1 millisecond',
           $4::date::timestamp AT TIME ZONE 'UTC' + $8 * interval '1 millisecond')`,
        [
          attemptId,
          actor.guestId,
          leaderboardRevision,
          leaderboardSlot,
          candidate.evidence,
          candidate.wrong === 0 ? 0 : 2,
          candidate.wrong,
          candidate.elapsed,
        ],
      )
      await db.query(
        `INSERT INTO loremaster.attempt_finalizations
          (attempt_id,guest_id,slot_id,outcome,score)
         VALUES ($1,$2,$3,'SOLVED',$4)`,
        [attemptId, actor.guestId, leaderboardSlot, candidate.score],
      )
      await db.query(
        `INSERT INTO loremaster.leaderboard_entries
          (attempt_id,guest_id,slot_id,pseudonym,evidence_level,
           total_wrong_guesses,elapsed_ms,score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          attemptId,
          actor.guestId,
          leaderboardSlot,
          `Candidate ${candidate.label}`,
          candidate.evidence,
          candidate.wrong,
          candidate.elapsed,
          candidate.score,
        ],
      )
    }
    const entries = await readDailyLeaderboard(db, leaderboardSlot)
    expect(entries.slice(0, 2).map((entry) => entry.attemptId)).toEqual([
      ids.get('better-tier'),
      ids.get('fast-lower-tier'),
    ])
    const tieIds = [ids.get('tie-a')!, ids.get('tie-b')!].sort()
    expect(entries.slice(2, 4).map((entry) => entry.attemptId)).toEqual(tieIds)
    expect(entries.slice(2, 5).map((entry) => entry.rank)).toEqual([3, 3, 5])
    expect(entries.at(-1)).toMatchObject({
      attemptId: ids.get('zero-score'),
      score: 0,
    })

    const firstPage = await readDailyLeaderboardPage(db, {
      slotId: leaderboardSlot,
      limit: 3,
    })
    expect(firstPage.items.map((entry) => entry.rank)).toEqual([1, 2, 3])
    expect(firstPage.nextPosition).not.toBeNull()
    const secondPage = await readDailyLeaderboardPage(db, {
      slotId: leaderboardSlot,
      limit: 3,
      cursor: firstPage.nextPosition!,
    })
    expect(secondPage.items.map((entry) => entry.rank)).toEqual([3, 5, 6])
    expect(secondPage.items.map((entry) => entry.attemptId)).toEqual(
      entries.slice(3).map((entry) => entry.attemptId),
    )
    expect(secondPage.nextPosition).toBeNull()
    await expect(
      readDailyLeaderboardPage(db, {
        slotId: leaderboardSlot,
        limit: 3,
        cursor: {
          ...firstPage.nextPosition!,
          elapsedMilliseconds: firstPage.nextPosition!.elapsedMilliseconds + 1,
        },
      }),
    ).rejects.toThrow('invalid leaderboard cursor')
  })

  it('returns bounded deterministic suggestions only for an owned current active attempt (B08-B10)', async () => {
    const actor = await identity()
    const attemptId = await seedActiveAttempt(actor.guestId)
    const suggestions = await readAttemptSuggestions(
      db,
      actor.guestId,
      attemptId,
      'mira',
    )
    expect(suggestions).toHaveLength(1)
    expect(suggestions?.[0]).toMatchObject({
      entityId: 'mira-vale',
      canonicalName: 'Mira Vale',
      publicRole: expect.stringContaining('archivist'),
      aliases: ['Mira'],
    })

    const foreign = await identity()
    expect(
      await readAttemptSuggestions(db, foreign.guestId, attemptId, 'mira'),
    ).toBeUndefined()
    await db.query(
      "UPDATE loremaster.attempts SET state='GIVEN_UP', terminal_at=clock_timestamp() WHERE id=$1",
      [attemptId],
    )
    expect(
      await readAttemptSuggestions(db, actor.guestId, attemptId, 'mira'),
    ).toBeUndefined()
  })

  it('rejects evidence overflow without a version or receipt (T07/T10)', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-reveals',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    for (let version = 0; version < 4; version += 1) {
      const reveal = await executeGameplayCommand(db, {
        ...actor,
        attemptId: started.projection.attemptId,
        expectedVersion: version,
        idempotencyKey: `reveal-${version}`,
        command: { kind: 'REVEAL' },
      })
      expect(reveal).toMatchObject({
        ok: true,
        projection: { evidenceLevel: version + 1, version: version + 1 },
      })
    }
    const rejected = await executeGameplayCommand(db, {
      ...actor,
      attemptId: started.projection.attemptId,
      expectedVersion: 4,
      idempotencyKey: 'reveal-overflow',
      command: { kind: 'REVEAL' },
    })
    expect(rejected).toMatchObject({
      ok: false,
      code: 'EVIDENCE_LIMIT',
      projection: { evidenceLevel: 4, version: 4 },
    })
    const receiptCount = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM loremaster.command_receipts
       WHERE guest_id=$1 AND idempotency_key='reveal-overflow'`,
      [actor.guestId],
    )
    expect(receiptCount.rows[0]?.count).toBe('0')
  })

  it('preserves participation from guesses but does not create it for reveal or give-up (T11/T12)', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-give-up',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const reveal = await executeGameplayCommand(db, {
      ...actor,
      attemptId: started.projection.attemptId,
      expectedVersion: 0,
      idempotencyKey: 'reveal-before-give-up',
      command: { kind: 'REVEAL' },
    })
    expect(reveal).toMatchObject({ ok: true })
    const givenUp = await executeGameplayCommand(db, {
      ...actor,
      attemptId: started.projection.attemptId,
      expectedVersion: 1,
      idempotencyKey: 'give-up',
      command: { kind: 'GIVE_UP' },
    })
    expect(givenUp).toMatchObject({
      ok: true,
      projection: { state: 'GIVEN_UP' },
    })
    const profile = await readProfile(db, actor.guestId)
    expect(profile).toMatchObject({
      currentStreak: 0,
      solvedCount: 0,
      failedCount: 1,
    })
  })

  it('retains exactly one participation day when a wrong guess is followed by give-up (T12)', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-wrong-give-up',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const { wrong } = await answerAndWrong()
    expect(
      await executeGameplayCommand(db, {
        ...actor,
        attemptId: started.projection.attemptId,
        expectedVersion: 0,
        idempotencyKey: 'wrong-before-give-up',
        command: { kind: 'GUESS', entityId: wrong },
      }),
    ).toMatchObject({ ok: true, projection: { totalWrongGuesses: 1 } })
    expect(
      await executeGameplayCommand(db, {
        ...actor,
        attemptId: started.projection.attemptId,
        expectedVersion: 1,
        idempotencyKey: 'give-up-after-wrong',
        command: { kind: 'GIVE_UP' },
      }),
    ).toMatchObject({ ok: true, projection: { state: 'GIVEN_UP' } })
    const participation = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM loremaster.participation_days
       WHERE guest_id=$1`,
      [actor.guestId],
    )
    expect(participation.rows[0]?.count).toBe('1')
  })

  it('rejects a reused key with a different canonical payload (T18)', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-key-conflict',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const first = await executeGameplayCommand(db, {
      ...actor,
      attemptId: started.projection.attemptId,
      expectedVersion: 0,
      idempotencyKey: 'shared-command-key',
      command: { kind: 'REVEAL' },
    })
    const conflict = await executeGameplayCommand(db, {
      ...actor,
      attemptId: started.projection.attemptId,
      expectedVersion: 1,
      idempotencyKey: 'shared-command-key',
      command: { kind: 'GIVE_UP' },
    })
    expect(first).toMatchObject({ ok: true })
    expect(conflict).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('rejects a gameplay-command key reused for start as an idempotency conflict', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-before-cross-kind-conflict',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    expect(
      await executeGameplayCommand(db, {
        ...actor,
        attemptId: started.projection.attemptId,
        expectedVersion: 0,
        idempotencyKey: 'cross-kind-conflict',
        command: { kind: 'REVEAL' },
      }),
    ).toMatchObject({ ok: true })
    expect(
      await startCurrentAttempt(db, {
        ...actor,
        idempotencyKey: 'cross-kind-conflict',
      }),
    ).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('fingerprints only the versioned allowlisted command tuple', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-canonical-fingerprint',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const first = await executeGameplayCommand(db, {
      ignoredTopLevel: 'first',
      command: { ignoredNested: 'first', kind: 'REVEAL' },
      idempotencyKey: 'canonical-fingerprint',
      expectedVersion: 0,
      attemptId: started.projection.attemptId,
      sessionId: actor.sessionId,
      guestId: actor.guestId,
    } as unknown as Parameters<typeof executeGameplayCommand>[1])
    const replay = await executeGameplayCommand(db, {
      guestId: actor.guestId,
      sessionId: actor.sessionId,
      attemptId: started.projection.attemptId,
      expectedVersion: 0,
      idempotencyKey: 'canonical-fingerprint',
      command: { kind: 'REVEAL', ignoredNested: 'different' },
      ignoredTopLevel: 'different',
    } as unknown as Parameters<typeof executeGameplayCommand>[1])
    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(replay).toMatchObject({ ok: true, replayed: true })
  })

  it('rejects a stored receipt outcome incompatible with its command', async () => {
    const actor = await identity()
    const started = await startCurrentAttempt(db, {
      ...actor,
      idempotencyKey: 'start-invalid-outcome',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    const storedFingerprint = createHash('sha256')
      .update(
        JSON.stringify(['v1', 'REVEAL', started.projection.attemptId, 0]),
        'utf8',
      )
      .digest()
    await expect(
      db.query(
        `INSERT INTO loremaster.command_receipts
         (id,guest_id,session_id,idempotency_key,command_fingerprint,
          command_kind,outcome_code,attempt_id,committed_version)
         VALUES ($1,$2,$3,'invalid-outcome',$4,'REVEAL','STARTED',$5,1)`,
        [
          randomUUID(),
          actor.guestId,
          actor.sessionId,
          storedFingerprint,
          started.projection.attemptId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects non-calendar leaderboard dates before querying PostgreSQL', async () => {
    await expect(readDailyLeaderboard(db, '2026-02-30')).rejects.toThrow(
      'invalid leaderboard query',
    )
  })

  it('enforces receipt-to-attempt ownership in the schema', async () => {
    const owner = await identity()
    const stranger = await identity()
    const started = await startCurrentAttempt(db, {
      ...owner,
      idempotencyKey: 'start-schema-owner',
    })
    if (!started.ok) throw new Error('start unexpectedly rejected')
    await expect(
      db.query(
        `INSERT INTO loremaster.command_receipts
          (id,guest_id,session_id,idempotency_key,command_fingerprint,
           command_kind,outcome_code,attempt_id,committed_version)
         VALUES ($1,$2,$3,'foreign-attempt',decode(repeat('ab',32),'hex'),
           'REVEAL','REVEALED',$4,1)`,
        [
          randomUUID(),
          stranger.guestId,
          stranger.sessionId,
          started.projection.attemptId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('lazily expires at closes_at and finalizes all effects exactly once (T13-T15/T23)', async () => {
    const marker = randomUUID().replaceAll('-', '')
    const historicalSlot = '2020-01-01'
    const publication = await importContentPack(
      db,
      {
        ...structuredClone(asterQuayContentPack),
        caseId: `expired-${marker}`,
        stableKey: `expired-${marker}`,
        slotId: historicalSlot,
        opensAt: '2020-01-01T00:00:00.000Z',
        closesAt: '2020-01-02T00:00:00.000Z',
      },
      'PUBLISH',
    )
    if (!publication.ok) throw new Error('historical publication failed')
    const actor = await identity()
    const attemptId = randomUUID()
    await db.query(
      `INSERT INTO loremaster.attempts
       (id,guest_id,revision_id,slot_id,started_at,updated_at)
       VALUES ($1,$2,$3,$4,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`,
      [attemptId, actor.guestId, publication.revisionId, historicalSlot],
    )

    const expired = await readOwnedAttempt(db, actor.guestId, attemptId)
    const replay = await readOwnedAttempt(db, actor.guestId, attemptId)
    expect(expired).toMatchObject({ state: 'EXPIRED', version: 1 })
    expect(replay).toEqual(expired)
    const mutation = await executeGameplayCommand(db, {
      ...actor,
      attemptId,
      expectedVersion: 1,
      idempotencyKey: 'after-expiry',
      command: { kind: 'GIVE_UP' },
    })
    expect(mutation).toMatchObject({
      ok: false,
      code: 'TERMINAL_ATTEMPT',
    })
    const persisted = await db.query<{
      effects: string
      finalized_at: Date
      terminal_at: Date
    }>(
      `SELECT attempt.terminal_at, finalization.finalized_at,
        (SELECT count(*) FROM loremaster.knowledge_contributions
         WHERE attempt_id=attempt.id)::text AS effects
       FROM loremaster.attempts attempt
       JOIN loremaster.attempt_finalizations finalization
         ON finalization.attempt_id=attempt.id
       WHERE attempt.id=$1`,
      [attemptId],
    )
    expect(persisted.rows[0]).toMatchObject({ effects: '1' })
    expect(persisted.rows[0]?.terminal_at.toISOString()).toBe(
      '2020-01-02T00:00:00.000Z',
    )
    expect(persisted.rows[0]?.finalized_at.toISOString()).toBe(
      '2020-01-02T00:00:00.000Z',
    )
  })

  it('lets a profile read alone expire and reconcile an attempt once (T14)', async () => {
    const historicalSlot = '2020-05-01'
    const historicalRevision = await publishHistorical(historicalSlot)
    const actor = await identity()
    const attemptId = await seedActiveAttempt(actor.guestId, {
      revision: historicalRevision,
      slot: historicalSlot,
      startedAt: '2020-05-01T00:00:00.000Z',
    })
    const first = await readProfile(db, actor.guestId)
    const second = await readProfile(db, actor.guestId)
    expect(first).toMatchObject({ solvedCount: 0, failedCount: 1 })
    expect(second).toEqual(first)
    const effects = await db.query<{
      contributions: string
      finalizations: string
    }>(
      `SELECT
        (SELECT count(*) FROM loremaster.attempt_finalizations
         WHERE attempt_id=$1)::text AS finalizations,
        (SELECT count(*) FROM loremaster.knowledge_contributions
         WHERE attempt_id=$1)::text AS contributions`,
      [attemptId],
    )
    expect(effects.rows[0]).toEqual({
      finalizations: '1',
      contributions: '1',
    })
  })

  it('replays a historical successful receipt with the reconciled terminal projection (T23)', async () => {
    const historicalSlot = '2020-06-01'
    const historicalRevision = await publishHistorical(historicalSlot)
    const actor = await identity()
    const attemptId = await seedActiveAttempt(actor.guestId, {
      revision: historicalRevision,
      slot: historicalSlot,
      startedAt: '2020-06-01T00:00:00.000Z',
      wrongGuessesAtLevel: 1,
      totalWrongGuesses: 1,
    })
    const { wrong } = await answerAndWrong(historicalRevision)
    await db.query('UPDATE loremaster.attempts SET version=1 WHERE id=$1', [
      attemptId,
    ])
    await db.query(
      `INSERT INTO loremaster.guesses
       (id,attempt_id,revision_id,guess_number,entity_id,was_correct,evidence_level,guessed_at)
       VALUES ($1,$2,$3,1,$4,false,0,'2020-06-01T00:01:00Z')`,
      [randomUUID(), attemptId, historicalRevision, wrong],
    )
    const storedFingerprint = createHash('sha256')
      .update(JSON.stringify(['v1', 'GUESS', attemptId, 0, wrong]), 'utf8')
      .digest()
    await db.query(
      `INSERT INTO loremaster.command_receipts
       (id,guest_id,session_id,idempotency_key,command_fingerprint,
        command_kind,outcome_code,attempt_id,committed_version)
       VALUES ($1,$2,$3,'historical-wrong',$4,'GUESS','WRONG',$5,1)`,
      [
        randomUUID(),
        actor.guestId,
        actor.sessionId,
        storedFingerprint,
        attemptId,
      ],
    )
    expect(await readProfile(db, actor.guestId)).toMatchObject({
      failedCount: 1,
    })
    const replay = await executeGameplayCommand(db, {
      ...actor,
      attemptId,
      expectedVersion: 0,
      idempotencyKey: 'historical-wrong',
      command: { kind: 'GUESS', entityId: wrong },
    })
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      outcomeCode: 'WRONG',
      projection: { state: 'EXPIRED', version: 2 },
    })
  })

  it('samples time after a contended attempt lock and applies expiry before a requested guess (T13)', async () => {
    const historicalSlot = '2020-07-01'
    const historicalRevision = await publishHistorical(historicalSlot)
    const actor = await identity()
    const attemptId = await seedActiveAttempt(actor.guestId, {
      revision: historicalRevision,
      slot: historicalSlot,
      startedAt: '2020-07-01T00:00:00.000Z',
    })
    const { answer } = await answerAndWrong(historicalRevision)
    const blocker = await db.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT 1 FROM loremaster.attempts WHERE id=$1 FOR UPDATE',
        [attemptId],
      )
      const pending = executeGameplayCommand(db, {
        ...actor,
        attemptId,
        expectedVersion: 0,
        idempotencyKey: 'closed-after-lock',
        command: { kind: 'GUESS', entityId: answer },
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({
        ok: false,
        code: 'TERMINAL_ATTEMPT',
        projection: { state: 'EXPIRED' },
      })
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }
    const writes = await db.query<{ guesses: string; receipts: string }>(
      `SELECT
        (SELECT count(*) FROM loremaster.guesses WHERE attempt_id=$1)::text AS guesses,
        (SELECT count(*) FROM loremaster.command_receipts
         WHERE guest_id=$2 AND idempotency_key='closed-after-lock')::text AS receipts`,
      [attemptId, actor.guestId],
    )
    expect(writes.rows[0]).toEqual({ guesses: '0', receipts: '0' })
  })
})
