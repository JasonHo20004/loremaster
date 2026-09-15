import type { EvidenceLevel } from '@loremaster/domain'

import type { DeadlineContext } from '../deadline.js'
import type { Database } from '../migrate.js'
import { transaction } from './runtime.js'
import type {
  LeaderboardEntry,
  LeaderboardPage,
  LeaderboardPageRequest,
} from './types.js'

function validSlotId(slotId: string): boolean {
  const parsedSlot = Date.parse(`${slotId}T00:00:00.000Z`)
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(slotId) &&
    Number.isFinite(parsedSlot) &&
    new Date(parsedSlot).toISOString().slice(0, 10) === slotId
  )
}

function validPageRequest(request: LeaderboardPageRequest): boolean {
  const cursor = request.cursor
  return (
    validSlotId(request.slotId) &&
    Number.isSafeInteger(request.limit) &&
    request.limit >= 1 &&
    request.limit <= 100 &&
    (cursor === undefined ||
      (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        cursor.attemptId,
      ) &&
        Number.isSafeInteger(cursor.evidenceLevel) &&
        cursor.evidenceLevel >= 0 &&
        cursor.evidenceLevel <= 4 &&
        Number.isSafeInteger(cursor.totalWrongGuesses) &&
        cursor.totalWrongGuesses >= 0 &&
        cursor.totalWrongGuesses <= 15 &&
        Number.isSafeInteger(cursor.elapsedMilliseconds) &&
        cursor.elapsedMilliseconds >= 0))
  )
}

function projectRow(row: {
  attempt_id: string
  pseudonym: string
  evidence_level: EvidenceLevel
  total_wrong_guesses: number
  elapsed_ms: string
  score: number
  rank: string
}): LeaderboardEntry {
  return {
    attemptId: row.attempt_id,
    pseudonym: row.pseudonym,
    evidenceLevel: row.evidence_level,
    totalWrongGuesses: row.total_wrong_guesses,
    elapsedMilliseconds: Number(row.elapsed_ms),
    score: row.score,
    rank: Number(row.rank),
  }
}

export async function readDailyLeaderboardPage(
  db: Database,
  request: LeaderboardPageRequest,
  deadline?: DeadlineContext,
): Promise<LeaderboardPage> {
  if (!validPageRequest(request))
    throw new RangeError('invalid leaderboard query')
  return transaction(
    db,
    async (client) => {
      if (request.cursor !== undefined) {
        const cursorExists = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM loremaster.leaderboard_entries
             WHERE slot_id=$1 AND attempt_id=$2 AND evidence_level=$3
               AND total_wrong_guesses=$4 AND elapsed_ms=$5
           ) AS exists`,
          [
            request.slotId,
            request.cursor.attemptId,
            request.cursor.evidenceLevel,
            request.cursor.totalWrongGuesses,
            request.cursor.elapsedMilliseconds,
          ],
        )
        if (cursorExists.rows[0]?.exists !== true)
          throw new RangeError('invalid leaderboard cursor')
      }
      const cursor = request.cursor
      const result = await client.query<{
        attempt_id: string
        pseudonym: string
        evidence_level: EvidenceLevel
        total_wrong_guesses: number
        elapsed_ms: string
        score: number
        rank: string
      }>(
        `WITH ranked AS (
           SELECT attempt_id, pseudonym, evidence_level, total_wrong_guesses,
                  elapsed_ms, score,
                  rank() OVER (
                    ORDER BY evidence_level, total_wrong_guesses, elapsed_ms
                  ) AS rank
           FROM loremaster.leaderboard_entries
           WHERE slot_id=$1
         )
         SELECT attempt_id::text, pseudonym, evidence_level,
                total_wrong_guesses, elapsed_ms::text, score, rank::text
         FROM ranked
         WHERE $2::uuid IS NULL OR
           (evidence_level, total_wrong_guesses, elapsed_ms, attempt_id) >
           ($3::smallint, $4::smallint, $5::bigint, $2::uuid)
         ORDER BY evidence_level, total_wrong_guesses, elapsed_ms, attempt_id
         LIMIT $6`,
        [
          request.slotId,
          cursor?.attemptId ?? null,
          cursor?.evidenceLevel ?? null,
          cursor?.totalWrongGuesses ?? null,
          cursor?.elapsedMilliseconds ?? null,
          request.limit + 1,
        ],
      )
      const items = result.rows.slice(0, request.limit).map(projectRow)
      const last = result.rows.length > request.limit ? items.at(-1) : undefined
      return {
        items,
        nextPosition:
          last === undefined
            ? null
            : {
                attemptId: last.attemptId,
                evidenceLevel: last.evidenceLevel,
                totalWrongGuesses: last.totalWrongGuesses,
                elapsedMilliseconds: last.elapsedMilliseconds,
              },
      }
    },
    { deadline, readOnly: true },
  )
}

export async function readDailyLeaderboard(
  db: Database,
  slotId: string,
  limit = 100,
  deadline?: DeadlineContext,
): Promise<readonly LeaderboardEntry[]> {
  if (
    !validSlotId(slotId) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new RangeError('invalid leaderboard query')
  return transaction(
    db,
    async (client) => {
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
      return result.rows.map(projectRow)
    },
    { deadline, readOnly: true },
  )
}
