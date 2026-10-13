import { projectPublicSuggestion } from '@loremaster/domain'
import type { DeadlineContext } from '../deadline.js'
import type { Database } from '../migrate.js'
import { attemptRow, currentRevision } from './attempt-records.js'
import { expireIfClosed } from './reconciliation.js'
import { databaseNow, lockGuest, transaction } from './runtime.js'
import type { EntitySuggestion } from './types.js'

export interface SuggestionIndexRow {
  readonly entityId: string
  readonly canonicalName: string
  readonly publicRole: string
  readonly aliases: readonly string[]
  readonly searchName: string
  readonly searchRole: string
  readonly searchAliases: readonly string[]
  readonly sortRank: number
}
export interface PublishedSuggestionIndex {
  readonly version: 1
  readonly revisionId: string
  readonly entities: readonly SuggestionIndexRow[]
}
export interface PublishedSuggestionCache {
  get(
    revisionId: string,
    signal?: AbortSignal,
  ): Promise<PublishedSuggestionIndex | undefined>
}

class InvalidPublishedSuggestionIndexError extends Error {
  readonly code = 'INVALID_SUGGESTION_INDEX'
  constructor() {
    super('Suggestion index capacity exceeded')
    this.name = 'InvalidPublishedSuggestionIndexError'
  }
}

export async function readCurrentPublishedRevision(
  db: Database,
  deadline?: DeadlineContext,
): Promise<string | undefined> {
  return transaction(
    db,
    async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id::text FROM loremaster.cache_published_revisions
       WHERE opens_at <= clock_timestamp() AND clock_timestamp() < closes_at
       ORDER BY opens_at DESC LIMIT 1`,
      )
      return result.rows[0]?.id
    },
    { deadline, readOnly: true, role: 'loremaster_cache_producer' },
  )
}

/** This authorization transaction commits before any Redis command. */
export async function authorizeAttemptSuggestions(
  db: Database,
  guestId: string,
  attemptId: string,
  deadline?: DeadlineContext,
): Promise<string | undefined> {
  return transaction(
    db,
    async (client) => {
      if (!(await lockGuest(client, guestId))) return undefined
      let attempt = await attemptRow(client, attemptId, guestId, true)
      if (!attempt) return undefined
      const sampledAt = await databaseNow(client)
      attempt = await expireIfClosed(client, attempt, sampledAt)
      const current = await currentRevision(client, sampledAt)
      if (
        attempt.state !== 'ACTIVE' ||
        !current ||
        current.id !== attempt.revision_id
      )
        return undefined
      return attempt.revision_id
    },
    { deadline },
  )
}

interface IndexDatabaseRow {
  readonly public_id: string
  readonly canonical_name: string
  readonly role: string
  readonly aliases: string[]
  readonly search_name: string
  readonly search_role: string
  readonly search_aliases: string[]
}

/** Worker logins use only the three security-barrier views. */
export async function readPublishedSuggestionIndex(
  db: Database,
  revisionId: string,
  deadline?: DeadlineContext,
  role: 'loremaster_runtime' | 'loremaster_cache_worker' = 'loremaster_runtime',
): Promise<PublishedSuggestionIndex | undefined> {
  const worker = role === 'loremaster_cache_worker'
  const revisionTable = worker ? 'cache_published_revisions' : 'case_revisions'
  const entityTable = worker ? 'cache_published_entities' : 'case_entities'
  const aliasTable = worker ? 'cache_published_aliases' : 'entity_aliases'
  return transaction(
    db,
    async (client) => {
      const revision = await client.query(
        `SELECT id FROM loremaster.${revisionTable} WHERE id=$1 AND status='PUBLISHED'`,
        [revisionId],
      )
      if (revision.rowCount !== 1) return undefined
      const rows = await client.query<IndexDatabaseRow>(
        `SELECT entity.public_id, entity.canonical_name, entity.role,
              lower(entity.canonical_name) AS search_name, lower(entity.role) AS search_role,
              array_agg(alias.alias ORDER BY lower(alias.alias), alias.alias) AS aliases,
              array_agg(lower(alias.alias) ORDER BY lower(alias.alias), alias.alias) AS search_aliases
       FROM loremaster.${entityTable} entity
       JOIN loremaster.${aliasTable} alias
         ON alias.revision_id=entity.revision_id AND alias.entity_id=entity.entity_id
       WHERE entity.revision_id=$1 AND entity.is_eligible
       GROUP BY entity.revision_id, entity.entity_id, entity.public_id,
                entity.canonical_name, entity.role
       ORDER BY lower(entity.canonical_name), entity.entity_id LIMIT 1001`,
        [revisionId],
      )
      if (rows.rows.length > 1000)
        throw new InvalidPublishedSuggestionIndexError()
      return {
        version: 1,
        revisionId,
        entities: rows.rows.map((row, sortRank) => ({
          entityId: row.public_id,
          canonicalName: row.canonical_name,
          publicRole: row.role,
          aliases: row.aliases,
          searchName: row.search_name,
          searchRole: row.search_role,
          searchAliases: row.search_aliases,
          sortRank,
        })),
      }
    },
    { deadline, readOnly: true, role },
  )
}

/** Mirrors the S6 SQL match classes and stable ordering, then projects public fields. */
export function filterSuggestionIndex(
  index: PublishedSuggestionIndex,
  query: string,
): readonly EntitySuggestion[] {
  const normalized = query.toLocaleLowerCase('en-US')
  const rank = (entity: SuggestionIndexRow): number => {
    if (entity.searchName === normalized) return 0
    if (entity.searchAliases.includes(normalized)) return 1
    if (entity.searchName.startsWith(normalized)) return 2
    if (entity.searchRole.startsWith(normalized)) return 3
    return 4
  }
  return index.entities
    .filter(
      (entity) =>
        entity.searchName.includes(normalized) ||
        entity.searchRole.includes(normalized) ||
        entity.searchAliases.some((alias) => alias.includes(normalized)),
    )
    .sort(
      (left, right) =>
        rank(left) - rank(right) || left.sortRank - right.sortRank,
    )
    .slice(0, 20)
    .map(projectPublicSuggestion)
}

export async function readAttemptSuggestions(
  db: Database,
  guestId: string,
  attemptId: string,
  query: string,
  deadline?: DeadlineContext,
  cache?: PublishedSuggestionCache,
): Promise<readonly EntitySuggestion[] | undefined> {
  if (query.length < 1 || query.length > 80)
    throw new RangeError('invalid suggestion query')
  const revisionId = await authorizeAttemptSuggestions(
    db,
    guestId,
    attemptId,
    deadline,
  )
  if (!revisionId) return undefined
  let cached: PublishedSuggestionIndex | undefined
  try {
    cached = await cache?.get(revisionId, deadline?.signal)
  } catch {
    cached = undefined
  }
  const index =
    cached ?? (await readPublishedSuggestionIndex(db, revisionId, deadline))
  if (!index) return undefined
  return filterSuggestionIndex(index, query)
}
