import {
  calculateProfileStatistics,
  type AttemptSnapshot,
  type TerminalAttempt,
} from '@loremaster/domain'

import type { Database } from '../migrate.js'
import { attemptRow } from './attempt-records.js'
import { expireIfClosed } from './reconciliation.js'
import { databaseNow, lockGuest, transaction } from './runtime.js'
import type { ProfileProjection } from './types.js'

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
