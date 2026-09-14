import { createHash, randomUUID } from 'node:crypto'

import {
  applyGuess,
  giveUp,
  projectNoCase,
  projectNotStarted,
  revealEvidence,
  type AttemptProjection,
  type CaseProjection,
} from '@loremaster/domain'
import type { PoolClient } from 'pg'

import type { Database } from '../migrate.js'
import {
  attemptRow,
  currentRevision,
  hydrateProjection,
  snapshot,
  type AttemptRow,
} from './attempt-records.js'
import { expireIfClosed, finalize } from './reconciliation.js'
import {
  databaseNow,
  lockGuest,
  sessionIsLive,
  transaction,
} from './runtime.js'
import type {
  GameplayCommandRequest,
  GameplayCommandKind,
  GameplayCommandOutcomeCode,
  GameplayCommandResult,
  StartAttemptRequest,
  StartAttemptResult,
} from './types.js'

interface ReceiptRow {
  attempt_id: string | null
  command_kind: unknown
  command_fingerprint: Buffer
  outcome_code: unknown
}

function fingerprint(value: readonly unknown[]): Buffer {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest()
}

function startFingerprint(): Buffer {
  return fingerprint(['v1', 'START'])
}

function commandFingerprint(
  request: GameplayCommandRequest,
): Buffer | undefined {
  if (typeof request.command !== 'object' || request.command === null)
    return undefined
  switch (request.command.kind) {
    case 'GUESS':
      if (typeof request.command.entityId !== 'string') return undefined
      return fingerprint([
        'v1',
        'GUESS',
        request.attemptId,
        request.expectedVersion,
        request.command.entityId,
      ])
    case 'REVEAL':
      return fingerprint([
        'v1',
        'REVEAL',
        request.attemptId,
        request.expectedVersion,
      ])
    case 'GIVE_UP':
      return fingerprint([
        'v1',
        'GIVE_UP',
        request.attemptId,
        request.expectedVersion,
      ])
    default:
      return undefined
  }
}

function startReceiptOutcome(receipt: ReceiptRow): 'STARTED' {
  if (receipt.command_kind === 'START' && receipt.outcome_code === 'STARTED')
    return 'STARTED'
  throw new Error('stored gameplay receipt has an invalid outcome code')
}

function commandReceiptOutcome(
  receipt: ReceiptRow,
  expectedKind: GameplayCommandKind,
): GameplayCommandOutcomeCode {
  const valid =
    (expectedKind === 'GUESS' &&
      (receipt.outcome_code === 'CORRECT' ||
        receipt.outcome_code === 'WRONG')) ||
    (expectedKind === 'REVEAL' && receipt.outcome_code === 'REVEALED') ||
    (expectedKind === 'GIVE_UP' && receipt.outcome_code === 'GIVEN_UP')
  if (receipt.command_kind === expectedKind && valid) {
    return receipt.outcome_code as GameplayCommandOutcomeCode
  }
  throw new Error('stored gameplay receipt has an invalid outcome code')
}

function validateKey(key: string): boolean {
  return (
    typeof key === 'string' &&
    key.length >= 1 &&
    key.length <= 128 &&
    /^[\x20-\x7e]+$/.test(key)
  )
}

async function receipt(
  client: PoolClient,
  guestId: string,
  key: string,
): Promise<ReceiptRow | undefined> {
  const result = await client.query<ReceiptRow>(
    `SELECT attempt_id::text, command_kind, command_fingerprint, outcome_code
     FROM loremaster.command_receipts WHERE guest_id = $1 AND idempotency_key = $2`,
    [guestId, key],
  )
  return result.rows[0]
}

export async function readCurrentCase(
  db: Database,
  guestId: string,
): Promise<CaseProjection> {
  return transaction(db, async (client) => {
    const revision = await currentRevision(client, await databaseNow(client))
    if (revision === undefined) return projectNoCase()
    const existing = await client.query<{ id: string }>(
      'SELECT id::text FROM loremaster.attempts WHERE guest_id = $1 AND slot_id = $2',
      [guestId, revision.slot_id],
    )
    if (existing.rows[0] === undefined)
      return projectNotStarted({
        slotId: revision.slot_id,
        opensAt: revision.opens_at.toISOString(),
        closesAt: revision.closes_at.toISOString(),
      })
    if (!(await lockGuest(client, guestId)))
      return projectNotStarted({
        slotId: revision.slot_id,
        opensAt: revision.opens_at.toISOString(),
        closesAt: revision.closes_at.toISOString(),
      })
    const row = await attemptRow(client, existing.rows[0].id, guestId, true)
    if (row === undefined) throw new Error('owned attempt disappeared')
    const sampledAt = await databaseNow(client)
    return hydrateProjection(
      client,
      await expireIfClosed(client, row, sampledAt),
      guestId,
    )
  })
}

export async function readOwnedAttempt(
  db: Database,
  guestId: string,
  attemptId: string,
): Promise<AttemptProjection | undefined> {
  return transaction(db, async (client) => {
    if (!(await lockGuest(client, guestId))) return undefined
    const row = await attemptRow(client, attemptId, guestId, true)
    if (row === undefined) return undefined
    const sampledAt = await databaseNow(client)
    return hydrateProjection(
      client,
      await expireIfClosed(client, row, sampledAt),
      guestId,
    )
  })
}

export async function startCurrentAttempt(
  db: Database,
  request: StartAttemptRequest,
): Promise<StartAttemptResult> {
  return transaction(db, async (client) => {
    if (!validateKey(request.idempotencyKey))
      return { ok: false, code: 'INVALID_COMMAND' }
    if (
      !(await lockGuest(client, request.guestId)) ||
      !(await sessionIsLive(client, request.guestId, request.sessionId))
    )
      return { ok: false, code: 'SESSION_EXPIRED' }
    const commandFingerprint = startFingerprint()
    const prior = await receipt(client, request.guestId, request.idempotencyKey)
    if (prior !== undefined) {
      if (
        !prior.command_fingerprint.equals(commandFingerprint) ||
        prior.attempt_id === null ||
        prior.command_kind !== 'START'
      )
        return { ok: false, code: 'IDEMPOTENCY_CONFLICT' }
      startReceiptOutcome(prior)
      const row = await attemptRow(
        client,
        prior.attempt_id,
        request.guestId,
        true,
      )
      if (row === undefined) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' }
      const sampledAt = await databaseNow(client)
      return {
        ok: true,
        outcomeCode: 'STARTED',
        replayed: true,
        projection: await hydrateProjection(
          client,
          await expireIfClosed(client, row, sampledAt),
          request.guestId,
        ),
      }
    }
    const sampledAt = await databaseNow(client)
    const revision = await currentRevision(client, sampledAt)
    if (revision === undefined) return { ok: false, code: 'NO_CASE' }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO loremaster.attempts
         (id, guest_id, revision_id, slot_id, started_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT (guest_id, slot_id) DO NOTHING RETURNING id::text`,
      [randomUUID(), request.guestId, revision.id, revision.slot_id, sampledAt],
    )
    const id =
      inserted.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          'SELECT id::text FROM loremaster.attempts WHERE guest_id = $1 AND slot_id = $2',
          [request.guestId, revision.slot_id],
        )
      ).rows[0]!.id
    const row = await attemptRow(client, id, request.guestId, true)
    if (row === undefined) throw new Error('attempt start failed')
    await client.query(
      `INSERT INTO loremaster.command_receipts
       (id, guest_id, session_id, idempotency_key, command_fingerprint, command_kind, outcome_code, attempt_id, committed_version)
       VALUES ($1,$2,$3,$4,$5,'START','STARTED',$6,$7)`,
      [
        randomUUID(),
        request.guestId,
        request.sessionId,
        request.idempotencyKey,
        commandFingerprint,
        id,
        row.version,
      ],
    )
    return {
      ok: true,
      outcomeCode: 'STARTED',
      replayed: false,
      projection: await hydrateProjection(client, row, request.guestId),
    }
  })
}

export async function executeGameplayCommand(
  db: Database,
  request: GameplayCommandRequest,
): Promise<GameplayCommandResult> {
  return transaction(db, async (client) => {
    if (
      !validateKey(request.idempotencyKey) ||
      !Number.isSafeInteger(request.expectedVersion) ||
      request.expectedVersion < 0
    ) {
      return { ok: false, code: 'INVALID_COMMAND' }
    }
    if (
      !(await lockGuest(client, request.guestId)) ||
      !(await sessionIsLive(client, request.guestId, request.sessionId))
    ) {
      return { ok: false, code: 'SESSION_EXPIRED' }
    }
    const canonicalFingerprint = commandFingerprint(request)
    if (canonicalFingerprint === undefined)
      return { ok: false, code: 'INVALID_COMMAND' }
    const prior = await receipt(client, request.guestId, request.idempotencyKey)
    if (prior !== undefined) {
      if (
        !prior.command_fingerprint.equals(canonicalFingerprint) ||
        prior.attempt_id !== request.attemptId
      )
        return { ok: false, code: 'IDEMPOTENCY_CONFLICT' }
      const replayRow = await attemptRow(
        client,
        request.attemptId,
        request.guestId,
        true,
      )
      if (replayRow === undefined) return { ok: false, code: 'UNKNOWN_ATTEMPT' }
      const sampledAt = await databaseNow(client)
      const historicalOutcome = commandReceiptOutcome(
        prior,
        request.command.kind,
      )
      return {
        ok: true,
        outcomeCode: historicalOutcome,
        replayed: true,
        projection: await hydrateProjection(
          client,
          await expireIfClosed(client, replayRow, sampledAt),
          request.guestId,
        ),
      }
    }
    let row = await attemptRow(client, request.attemptId, request.guestId, true)
    if (row === undefined) return { ok: false, code: 'UNKNOWN_ATTEMPT' }
    const sampledAt = await databaseNow(client)
    row = await expireIfClosed(client, row, sampledAt)
    if (row.state !== 'ACTIVE')
      return {
        ok: false,
        code: 'TERMINAL_ATTEMPT',
        projection: await hydrateProjection(client, row, request.guestId),
      }
    if (row.version !== request.expectedVersion)
      return {
        ok: false,
        code: 'STALE_VERSION',
        projection: await hydrateProjection(client, row, request.guestId),
      }

    const before = snapshot(row)
    let transition
    let committedOutcomeCode: GameplayCommandOutcomeCode
    let guessedEntityId: string | undefined
    if (request.command.kind === 'GUESS') {
      const entity = await client.query<{ correct: boolean }>(
        `SELECT (entity.entity_id = revision.answer_entity_id) AS correct
         FROM loremaster.case_entities entity JOIN loremaster.case_revisions revision ON revision.id = entity.revision_id
         WHERE entity.revision_id = $1 AND entity.entity_id = $2 AND entity.is_eligible`,
        [row.revision_id, request.command.entityId],
      )
      if (entity.rows[0] === undefined)
        return { ok: false, code: 'UNKNOWN_ENTITY' }
      guessedEntityId = request.command.entityId
      transition = applyGuess(before, entity.rows[0].correct)
      committedOutcomeCode = entity.rows[0].correct ? 'CORRECT' : 'WRONG'
    } else if (request.command.kind === 'REVEAL') {
      transition = revealEvidence(before)
      committedOutcomeCode = 'REVEALED'
    } else if (request.command.kind === 'GIVE_UP') {
      transition = giveUp(before)
      committedOutcomeCode = 'GIVEN_UP'
    } else return { ok: false, code: 'INVALID_COMMAND' }
    if (!transition.accepted)
      return {
        ok: false,
        code: transition.reason,
        projection: await hydrateProjection(client, row, request.guestId),
      }
    const at = sampledAt
    const next = transition.attempt
    if (guessedEntityId !== undefined) {
      await client.query(
        `INSERT INTO loremaster.guesses (id, attempt_id, revision_id, guess_number, entity_id, was_correct, evidence_level, guessed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          row.id,
          row.revision_id,
          row.total_wrong_guesses + 1,
          guessedEntityId,
          next.state === 'SOLVED',
          row.evidence_level,
          at,
        ],
      )
      await client.query(
        `INSERT INTO loremaster.participation_days (guest_id, utc_day, first_guess_at)
         VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC')::date, $2) ON CONFLICT (guest_id, utc_day) DO NOTHING`,
        [row.guest_id, at],
      )
    }
    if (next.state !== 'ACTIVE') row = await finalize(client, row, next, at)
    else {
      row = (
        await client.query<AttemptRow>(
          `UPDATE loremaster.attempts SET evidence_level=$2, wrong_guesses_at_level=$3,
         total_wrong_guesses=$4, version=version+1, updated_at=$5 WHERE id=$1
         RETURNING id::text, guest_id::text, revision_id::text, slot_id::text, state,
         evidence_level, wrong_guesses_at_level, total_wrong_guesses, version, started_at,
         $6::timestamptz AS closes_at, $5::timestamptz AS snapshot_at`,
          [
            row.id,
            next.evidenceLevel,
            next.wrongGuessesAtLevel,
            next.totalWrongGuesses,
            at,
            row.closes_at,
          ],
        )
      ).rows[0]!
    }
    await client.query(
      `INSERT INTO loremaster.command_receipts
       (id,guest_id,session_id,idempotency_key,command_fingerprint,command_kind,outcome_code,attempt_id,committed_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        request.guestId,
        request.sessionId,
        request.idempotencyKey,
        canonicalFingerprint,
        request.command.kind,
        committedOutcomeCode,
        row.id,
        row.version,
      ],
    )
    return {
      ok: true,
      outcomeCode: committedOutcomeCode,
      replayed: false,
      projection: await hydrateProjection(client, row, request.guestId),
    }
  })
}
