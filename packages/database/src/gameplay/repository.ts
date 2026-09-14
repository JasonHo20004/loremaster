import { createHash, randomUUID } from 'node:crypto'

import {
  applyGuess,
  calculateProfileStatistics,
  expire,
  giveUp,
  projectAttempt,
  projectNoCase,
  projectNotStarted,
  regionalPerformanceHundredths,
  revealEvidence,
  scoreSolvedAttempt,
  type AttemptProjection,
  type AttemptSnapshot,
  type CaseProjection,
  type EvidenceLevel,
  type PrivateAttemptRecord,
  type PrivateCaseFile,
  type TerminalAttempt,
} from '@loremaster/domain'
import type { PoolClient } from 'pg'

import type { Database } from '../migrate.js'
import type {
  GameplayCommandRequest,
  GameplayCommandKind,
  GameplayCommandOutcomeCode,
  GameplayCommandResult,
  LeaderboardEntry,
  ProfileProjection,
  StartAttemptRequest,
  StartAttemptResult,
} from './types.js'

interface AttemptRow {
  id: string
  guest_id: string
  revision_id: string
  slot_id: string
  state: AttemptSnapshot['state']
  evidence_level: EvidenceLevel
  wrong_guesses_at_level: 0 | 1 | 2
  total_wrong_guesses: number
  version: number
  started_at: Date
  closes_at: Date
  snapshot_at: Date
}

interface ReceiptRow {
  attempt_id: string | null
  command_kind: unknown
  command_fingerprint: Buffer
  outcome_code: unknown
}

async function transaction<T>(
  db: Database,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE loremaster_runtime')
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL statement_timeout = '3s'")
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function lockGuest(
  client: PoolClient,
  guestId: string,
): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM loremaster.guests WHERE id = $1 FOR UPDATE',
    [guestId],
  )
  return result.rowCount === 1
}

async function sessionIsLive(
  client: PoolClient,
  guestId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM loremaster.guest_sessions
     WHERE id = $1 AND guest_id = $2 AND expires_at > clock_timestamp()
    `,
    [sessionId, guestId],
  )
  return result.rowCount === 1
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
  const result = await client.query<{
    attempt_id: string | null
    command_kind: unknown
    command_fingerprint: Buffer
    outcome_code: unknown
  }>(
    `SELECT attempt_id::text, command_kind, command_fingerprint, outcome_code
     FROM loremaster.command_receipts WHERE guest_id = $1 AND idempotency_key = $2`,
    [guestId, key],
  )
  const row = result.rows[0]
  if (row === undefined) return undefined
  return row
}

async function currentRevision(
  client: PoolClient,
  sampledAt: Date,
): Promise<
  { id: string; slot_id: string; opens_at: Date; closes_at: Date } | undefined
> {
  const result = await client.query<{
    id: string
    slot_id: string
    opens_at: Date
    closes_at: Date
  }>(
    `SELECT id::text, slot_id::text, opens_at, closes_at
     FROM loremaster.case_revisions
     WHERE status = 'PUBLISHED'
       AND opens_at <= $1 AND $1 < closes_at
     ORDER BY opens_at DESC LIMIT 1`,
    [sampledAt],
  )
  return result.rows[0]
}

async function attemptRow(
  client: PoolClient,
  attemptId: string,
  guestId: string,
  lock = false,
): Promise<AttemptRow | undefined> {
  const result = await client.query<AttemptRow>(
    `SELECT attempt.id::text, attempt.guest_id::text, attempt.revision_id::text,
            attempt.slot_id::text, attempt.state, attempt.evidence_level,
            attempt.wrong_guesses_at_level, attempt.total_wrong_guesses,
            attempt.version, attempt.started_at, revision.closes_at,
            clock_timestamp() AS snapshot_at
     FROM loremaster.attempts attempt
     JOIN loremaster.case_revisions revision ON revision.id = attempt.revision_id
     WHERE attempt.id = $1 AND attempt.guest_id = $2
     ${lock ? 'FOR UPDATE OF attempt' : ''}`,
    [attemptId, guestId],
  )
  return result.rows[0]
}

async function hydrateCase(
  client: PoolClient,
  revisionId: string,
): Promise<PrivateCaseFile> {
  const revisionResult = await client.query<{
    id: string
    slot_id: string
    opens_at: Date
    closes_at: Date
    briefing: string
    answer_entity_id: string
  }>(
    `SELECT id::text, slot_id::text, opens_at, closes_at, briefing, answer_entity_id::text
     FROM loremaster.case_revisions WHERE id = $1 AND status = 'PUBLISHED'`,
    [revisionId],
  )
  const revision = revisionResult.rows[0]
  if (revision === undefined)
    throw new Error('published case revision is missing')
  const [entities, aliases, evidence, sources] = await Promise.all([
    client.query<{ entity_id: string; canonical_name: string; role: string }>(
      `SELECT entity_id::text, canonical_name, role FROM loremaster.case_entities
       WHERE revision_id = $1 AND is_eligible ORDER BY canonical_name, entity_id`,
      [revisionId],
    ),
    client.query<{ entity_id: string; alias: string }>(
      `SELECT entity_id::text, alias FROM loremaster.entity_aliases WHERE revision_id = $1 ORDER BY alias`,
      [revisionId],
    ),
    client.query<{
      evidence_order: 1 | 2 | 3 | 4
      evidence_text: string
      explanation: string
    }>(
      `SELECT evidence_order, evidence_text, explanation FROM loremaster.case_evidence
       WHERE revision_id = $1 ORDER BY evidence_order`,
      [revisionId],
    ),
    client.query<{ source_id: string }>(
      `SELECT source_id FROM loremaster.case_sources WHERE revision_id = $1 ORDER BY source_order`,
      [revisionId],
    ),
  ])
  if (evidence.rows.length !== 4)
    throw new Error('published case evidence is incomplete')
  const sourceReferences = sources.rows.map((row) => row.source_id)
  const hydratedEvidence = evidence.rows.map((row) => ({
    level: row.evidence_order,
    text: row.evidence_text,
    explanation: row.explanation,
    sourceReferences: [...sourceReferences],
  }))
  const evidenceSet: PrivateCaseFile['evidence'] = [
    hydratedEvidence[0]!,
    hydratedEvidence[1]!,
    hydratedEvidence[2]!,
    hydratedEvidence[3]!,
  ] as PrivateCaseFile['evidence']
  return {
    slotId: revision.slot_id,
    revisionId: revision.id,
    opensAt: revision.opens_at.toISOString(),
    closesAt: revision.closes_at.toISOString(),
    briefing: revision.briefing,
    answerEntityId: revision.answer_entity_id,
    suggestions: entities.rows.map((entity) => ({
      entityId: entity.entity_id,
      canonicalName: entity.canonical_name,
      publicRole: entity.role,
      aliases: aliases.rows
        .filter((alias) => alias.entity_id === entity.entity_id)
        .map((alias) => alias.alias),
    })),
    evidence: evidenceSet,
  }
}

async function hydrateProjection(
  client: PoolClient,
  row: AttemptRow,
  guestId: string,
): Promise<AttemptProjection> {
  const guesses = await client.query<{
    id: string
    entity_id: string
    guessed_at: Date
  }>(
    `SELECT id::text, entity_id::text, guessed_at FROM loremaster.guesses
     WHERE attempt_id = $1 ORDER BY guess_number`,
    [row.id],
  )
  const record: PrivateAttemptRecord = {
    attemptId: row.id,
    ownerGuestId: row.guest_id,
    slotId: row.slot_id,
    revisionId: row.revision_id,
    version: row.version,
    startedAt: row.started_at.toISOString(),
    snapshotAt: row.snapshot_at.toISOString(),
    attempt: snapshot(row),
    guesses: guesses.rows.map((guess) => ({
      guessId: guess.id,
      guestId,
      entityId: guess.entity_id,
      guessedAt: guess.guessed_at.toISOString(),
    })),
  }
  return projectAttempt(
    await hydrateCase(client, row.revision_id),
    record,
    guestId,
  )
}

function snapshot(row: AttemptRow): AttemptSnapshot {
  return {
    state: row.state,
    evidenceLevel: row.evidence_level,
    wrongGuessesAtLevel: row.wrong_guesses_at_level,
    totalWrongGuesses: row.total_wrong_guesses,
  } as AttemptSnapshot
}

async function databaseNow(client: PoolClient): Promise<Date> {
  const result = await client.query<{ now: Date }>(
    'SELECT clock_timestamp() AS now',
  )
  return result.rows[0]!.now
}

async function finalize(
  client: PoolClient,
  row: AttemptRow,
  terminal: TerminalAttempt,
  at: Date,
): Promise<AttemptRow> {
  const elapsed = Math.max(0, at.getTime() - row.started_at.getTime())
  const score =
    terminal.state === 'SOLVED'
      ? scoreSolvedAttempt(terminal, elapsed).score
      : 0
  const updated = await client.query<AttemptRow>(
    `UPDATE loremaster.attempts SET state = $2, evidence_level = $3,
       wrong_guesses_at_level = $4, total_wrong_guesses = $5,
       version = version + 1, updated_at = $6, terminal_at = $6
     WHERE id = $1 RETURNING id::text, guest_id::text, revision_id::text,
       slot_id::text, state, evidence_level, wrong_guesses_at_level,
       total_wrong_guesses, version, started_at, $7::timestamptz AS closes_at,
       $6::timestamptz AS snapshot_at`,
    [
      row.id,
      terminal.state,
      terminal.evidenceLevel,
      terminal.wrongGuessesAtLevel,
      terminal.totalWrongGuesses,
      at,
      row.closes_at,
    ],
  )
  const finalization = await client.query(
    `INSERT INTO loremaster.attempt_finalizations
       (attempt_id, guest_id, slot_id, outcome, score, finalized_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (attempt_id) DO NOTHING
     RETURNING attempt_id`,
    [row.id, row.guest_id, row.slot_id, terminal.state, score, at],
  )
  if (finalization.rowCount !== 1) return updated.rows[0]!
  const performance = regionalPerformanceHundredths(terminal)
  await client.query(
    `WITH inserted AS (
       INSERT INTO loremaster.knowledge_contributions
         (attempt_id, revision_id, guest_id, slot_id, outcome, region_id, alpha_delta, beta_delta)
       SELECT $1, $2, $3, $4, $5, region_id, $6::numeric / 100, (100 - $6::numeric) / 100
       FROM loremaster.revision_regions WHERE revision_id = $2
       ON CONFLICT (attempt_id, region_id) DO NOTHING
       RETURNING guest_id, region_id, alpha_delta, beta_delta
     )
     INSERT INTO loremaster.regional_knowledge (guest_id, region_id, alpha, beta, sample_count)
     SELECT guest_id, region_id, 2 + alpha_delta, 2 + beta_delta, 1 FROM inserted
     ON CONFLICT (guest_id, region_id) DO UPDATE SET
       alpha = loremaster.regional_knowledge.alpha + EXCLUDED.alpha - 2,
       beta = loremaster.regional_knowledge.beta + EXCLUDED.beta - 2,
       sample_count = loremaster.regional_knowledge.sample_count + 1`,
    [
      row.id,
      row.revision_id,
      row.guest_id,
      row.slot_id,
      terminal.state,
      performance,
    ],
  )
  if (terminal.state === 'SOLVED') {
    const pseudonym = await client.query<{ pseudonym: string }>(
      'SELECT pseudonym FROM loremaster.guests WHERE id = $1',
      [row.guest_id],
    )
    await client.query(
      `INSERT INTO loremaster.leaderboard_entries
       (attempt_id, guest_id, slot_id, pseudonym, evidence_level, total_wrong_guesses, elapsed_ms, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (attempt_id) DO NOTHING`,
      [
        row.id,
        row.guest_id,
        row.slot_id,
        pseudonym.rows[0]!.pseudonym,
        terminal.evidenceLevel,
        terminal.totalWrongGuesses,
        elapsed,
        score,
      ],
    )
  }
  return updated.rows[0]!
}

async function expireIfClosed(
  client: PoolClient,
  row: AttemptRow,
  sampledAt: Date,
): Promise<AttemptRow> {
  if (row.state !== 'ACTIVE') return row
  if (sampledAt.getTime() < row.closes_at.getTime()) return row
  const transition = expire(snapshot(row))
  if (!transition.accepted || transition.attempt.state === 'ACTIVE') return row
  return finalize(client, row, transition.attempt, row.closes_at)
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

export async function readProfile(
  db: Database,
  guestId: string,
): Promise<ProfileProjection | undefined> {
  return transaction(db, async (client) => {
    if (!(await lockGuest(client, guestId))) return undefined
    const active = await client.query<{ id: string }>(
      `SELECT id::text FROM loremaster.attempts WHERE guest_id=$1 AND state='ACTIVE'
       ORDER BY slot_id, id FOR UPDATE`,
      [guestId],
    )
    const sampledAt = await databaseNow(client)
    for (const item of active.rows) {
      const row = await attemptRow(client, item.id, guestId)
      if (row !== undefined) await expireIfClosed(client, row, sampledAt)
    }
    const [finalized, days, regions, today] = await Promise.all([
      client.query<AttemptSnapshot>(
        `SELECT attempt.state, attempt.evidence_level AS "evidenceLevel",
          attempt.wrong_guesses_at_level AS "wrongGuessesAtLevel",
          attempt.total_wrong_guesses AS "totalWrongGuesses"
         FROM loremaster.attempts attempt JOIN loremaster.attempt_finalizations f ON f.attempt_id=attempt.id
         WHERE attempt.guest_id=$1 ORDER BY attempt.slot_id, attempt.id`,
        [guestId],
      ),
      client.query<{ day: string }>(
        'SELECT utc_day::text AS day FROM loremaster.participation_days WHERE guest_id=$1 ORDER BY utc_day',
        [guestId],
      ),
      client.query<{
        region_id: string
        alpha: string
        beta: string
        sample_count: number
      }>(
        `SELECT catalog.id AS region_id, COALESCE(knowledge.alpha, 2)::text AS alpha,
                COALESCE(knowledge.beta, 2)::text AS beta,
                COALESCE(knowledge.sample_count, 0)::integer AS sample_count
         FROM loremaster.region_catalog catalog
         LEFT JOIN loremaster.regional_knowledge knowledge
           ON knowledge.region_id = catalog.id AND knowledge.guest_id = $1
         ORDER BY catalog.id`,
        [guestId],
      ),
      client.query<{ day: string }>(
        "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day",
      ),
    ])
    const statistics = calculateProfileStatistics(
      finalized.rows as TerminalAttempt[],
      days.rows.map((row) => row.day),
      today.rows[0]!.day,
    )
    return {
      ...statistics,
      regionalKnowledge: regions.rows.map((region) => {
        const alphaHundredths = Math.round(Number(region.alpha) * 100)
        const betaHundredths = Math.round(Number(region.beta) * 100)
        return {
          regionId: region.region_id,
          alphaHundredths,
          betaHundredths,
          sampleCount: region.sample_count,
          displayPercentage: Math.floor(
            (alphaHundredths * 100 + (alphaHundredths + betaHundredths) / 2) /
              (alphaHundredths + betaHundredths),
          ),
        }
      }),
    }
  })
}

export async function readDailyLeaderboard(
  db: Database,
  slotId: string,
  limit = 100,
): Promise<readonly LeaderboardEntry[]> {
  const parsedSlot = Date.parse(`${slotId}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(slotId) ||
    !Number.isFinite(parsedSlot) ||
    new Date(parsedSlot).toISOString().slice(0, 10) !== slotId ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new RangeError('invalid leaderboard query')
  return transaction(db, async (client) => {
    const result = await client.query<{
      attempt_id: string
      pseudonym: string
      evidence_level: EvidenceLevel
      total_wrong_guesses: number
      elapsed_ms: string
      score: number
      rank: string
    }>(
      `SELECT attempt_id::text, pseudonym, evidence_level, total_wrong_guesses, elapsed_ms::text, score,
         rank() OVER (ORDER BY evidence_level, total_wrong_guesses, elapsed_ms)::text AS rank
       FROM loremaster.leaderboard_entries WHERE slot_id=$1
       ORDER BY evidence_level, total_wrong_guesses, elapsed_ms, attempt_id LIMIT $2`,
      [slotId, limit],
    )
    return result.rows.map((row) => ({
      attemptId: row.attempt_id,
      pseudonym: row.pseudonym,
      evidenceLevel: row.evidence_level,
      totalWrongGuesses: row.total_wrong_guesses,
      elapsedMilliseconds: Number(row.elapsed_ms),
      score: row.score,
      rank: Number(row.rank),
    }))
  })
}
