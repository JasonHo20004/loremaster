import type { EvidenceLevel } from '@loremaster/domain'

import type { Database } from '../migrate.js'
import { transaction } from './runtime.js'
import type { LeaderboardEntry } from './types.js'

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
