import {
  expire,
  regionalPerformanceHundredths,
  scoreSolvedAttempt,
  type TerminalAttempt,
} from '@loremaster/domain'
import type { PoolClient } from 'pg'

import { snapshot, type AttemptRow } from './attempt-records.js'

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

export async function expireIfClosed(
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

export { finalize }
