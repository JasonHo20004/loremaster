import type { DeadlineContext } from '../deadline.js'
import type { Database } from '../migrate.js'
import { attemptRow, currentRevision } from './attempt-records.js'
import { expireIfClosed } from './reconciliation.js'
import { databaseNow, lockGuest, transaction } from './runtime.js'
import type { EntitySuggestion } from './types.js'

export async function readAttemptSuggestions(
  db: Database,
  guestId: string,
  attemptId: string,
  query: string,
  deadline?: DeadlineContext,
): Promise<readonly EntitySuggestion[] | undefined> {
  if (query.length < 1 || query.length > 80)
    throw new RangeError('invalid suggestion query')
  return transaction(
    db,
    async (client) => {
      if (!(await lockGuest(client, guestId))) return undefined
      let attempt = await attemptRow(client, attemptId, guestId, true)
      if (attempt === undefined) return undefined
      const sampledAt = await databaseNow(client)
      attempt = await expireIfClosed(client, attempt, sampledAt)
      const current = await currentRevision(client, sampledAt)
      if (
        attempt.state !== 'ACTIVE' ||
        current === undefined ||
        current.id !== attempt.revision_id
      )
        return undefined

      const normalized = query.toLocaleLowerCase('en-US')
      const result = await client.query<{
        aliases: string[]
        canonical_name: string
        entity_id: string
        role: string
      }>(
        `SELECT entity.public_id AS entity_id, entity.canonical_name, entity.role,
                array_agg(alias.alias ORDER BY lower(alias.alias), alias.alias) AS aliases
         FROM loremaster.case_entities entity
         JOIN loremaster.entity_aliases alias
           ON alias.revision_id=entity.revision_id
          AND alias.entity_id=entity.entity_id
         WHERE entity.revision_id=$1 AND entity.is_eligible
           AND (
             lower(entity.canonical_name) LIKE '%' || $2 || '%' ESCAPE '\\'
             OR lower(entity.role) LIKE '%' || $2 || '%' ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM loremaster.entity_aliases matching_alias
               WHERE matching_alias.revision_id=entity.revision_id
                 AND matching_alias.entity_id=entity.entity_id
                 AND lower(matching_alias.alias) LIKE '%' || $2 || '%' ESCAPE '\\'
             )
           )
         GROUP BY entity.revision_id, entity.entity_id, entity.public_id,
                  entity.canonical_name, entity.role
         ORDER BY
           CASE
             WHEN lower(entity.canonical_name)=$2 THEN 0
             WHEN EXISTS (
               SELECT 1 FROM loremaster.entity_aliases exact_alias
               WHERE exact_alias.revision_id=entity.revision_id
                 AND exact_alias.entity_id=entity.entity_id
                 AND lower(exact_alias.alias)=$2
             ) THEN 1
             WHEN lower(entity.canonical_name) LIKE $2 || '%' ESCAPE '\\' THEN 2
             WHEN lower(entity.role) LIKE $2 || '%' ESCAPE '\\' THEN 3
             ELSE 4
           END,
           lower(entity.canonical_name), entity.entity_id
         LIMIT 20`,
        [attempt.revision_id, normalized.replace(/[\\%_]/gu, '\\$&')],
      )
      return result.rows.map((row) => ({
        aliases: row.aliases,
        canonicalName: row.canonical_name,
        entityId: row.entity_id,
        publicRole: row.role,
      }))
    },
    { deadline },
  )
}
