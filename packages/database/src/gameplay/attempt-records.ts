import {
  projectAttempt,
  type AttemptProjection,
  type AttemptSnapshot,
  type EvidenceLevel,
  type PrivateAttemptRecord,
  type PrivateCaseFile,
} from '@loremaster/domain'
import type { PoolClient } from 'pg'

export interface AttemptRow {
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

export async function currentRevision(
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

export async function attemptRow(
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

export async function hydrateProjection(
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

export function snapshot(row: AttemptRow): AttemptSnapshot {
  return {
    state: row.state,
    evidenceLevel: row.evidence_level,
    wrongGuessesAtLevel: row.wrong_guesses_at_level,
    totalWrongGuesses: row.total_wrong_guesses,
  } as AttemptSnapshot
}
