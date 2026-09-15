import { createHmac, timingSafeEqual } from 'node:crypto'

import type { CursorHmacKey } from '@loremaster/config'
import { leaderboardCursorPayloadSchema } from '@loremaster/contracts'
import type {
  Database,
  DeadlineContext,
  EntitySuggestion,
  LeaderboardPage,
  LeaderboardPageRequest,
  LeaderboardPosition,
  ProfileProjection,
} from '@loremaster/database'
import {
  readAttemptSuggestions,
  readDailyLeaderboardPage,
  readProfile,
} from '@loremaster/database'

import type {
  AuthenticatedIdentity,
  KernelHandlerContext,
  KernelHandlers,
} from '../http/dependencies.js'
import { PublicHttpError } from '../http/errors.js'

interface CursorPayload {
  readonly attemptId: string
  readonly elapsedMilliseconds: number
  readonly evidenceLevel: 0 | 1 | 2 | 3 | 4
  readonly orderingSchema: 'e-w-elapsed-id-v1'
  readonly slotId: string
  readonly totalWrongGuesses: number
  readonly version: 1
}

interface AttemptPath {
  readonly attemptId: string
}

interface LeaderboardPath {
  readonly slotId: string
}

interface LeaderboardQuery {
  readonly cursor?: string
  readonly limit?: string
}

interface SuggestionsQuery {
  readonly q: string
}

export interface ReportingRouteRepository {
  readAttemptSuggestions(
    guestId: string,
    attemptId: string,
    query: string,
    deadline: DeadlineContext,
  ): Promise<readonly EntitySuggestion[] | undefined>
  readDailyLeaderboardPage(
    request: LeaderboardPageRequest,
    deadline: DeadlineContext,
  ): Promise<LeaderboardPage>
  readProfile(
    guestId: string,
    deadline: DeadlineContext,
  ): Promise<ProfileProjection | undefined>
}

export function createDatabaseReportingRepository(
  database: Database,
): ReportingRouteRepository {
  return {
    readAttemptSuggestions: (guestId, attemptId, query, deadline) =>
      readAttemptSuggestions(database, guestId, attemptId, query, deadline),
    readDailyLeaderboardPage: (request, deadline) =>
      readDailyLeaderboardPage(database, request, deadline),
    readProfile: (guestId, deadline) =>
      readProfile(database, guestId, deadline),
  }
}

export interface LeaderboardCursorKeys {
  readonly active: CursorHmacKey
  readonly previous?: CursorHmacKey
}

function authenticated(context: KernelHandlerContext): AuthenticatedIdentity {
  if (context.identity === undefined)
    throw new PublicHttpError('AUTHENTICATION_REQUIRED')
  return context.identity
}

function invalidCursor(): PublicHttpError {
  return new PublicHttpError('INVALID_REQUEST', [
    { path: '$.cursor', code: 'INVALID_FORMAT' },
  ])
}

function cursorSignature(key: Uint8Array, authenticated: string): Buffer {
  return createHmac('sha256', key).update(authenticated, 'utf8').digest()
}

function encodeCursor(
  keys: LeaderboardCursorKeys,
  slotId: string,
  position: LeaderboardPosition,
): string {
  const payload: CursorPayload = {
    version: 1,
    slotId,
    orderingSchema: 'e-w-elapsed-id-v1',
    ...position,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )
  const authenticated = `v1.${keys.active.version}.${encoded}`
  return `${authenticated}.${cursorSignature(keys.active.key, authenticated).toString('base64url')}`
}

function decodeCursor(
  keys: LeaderboardCursorKeys,
  slotId: string,
  cursor: string,
): LeaderboardPosition {
  const parts = cursor.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw invalidCursor()
  const key = [keys.active, keys.previous].find(
    (candidate) => candidate?.version === parts[1],
  )
  if (key === undefined) throw invalidCursor()
  const authenticated = parts.slice(0, 3).join('.')
  const expected = cursorSignature(key.key, authenticated)
  let actual: Buffer
  try {
    actual = Buffer.from(parts[3]!, 'base64url')
  } catch {
    throw invalidCursor()
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw invalidCursor()
  try {
    const parsed = leaderboardCursorPayloadSchema.safeParse(
      JSON.parse(Buffer.from(parts[2]!, 'base64url').toString('utf8')),
    )
    if (!parsed.success || parsed.data.slotId !== slotId) throw invalidCursor()
    return {
      attemptId: parsed.data.attemptId,
      evidenceLevel: parsed.data.evidenceLevel,
      totalWrongGuesses: parsed.data.totalWrongGuesses,
      elapsedMilliseconds: parsed.data.elapsedMilliseconds,
    }
  } catch (error) {
    if (error instanceof PublicHttpError) throw error
    throw invalidCursor()
  }
}

function validateKeys(keys: LeaderboardCursorKeys): void {
  const configured = [keys.active, keys.previous].filter(
    (key): key is CursorHmacKey => key !== undefined,
  )
  if (
    configured.some(
      (key) =>
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/u.test(key.version) ||
        key.key.byteLength < 32,
    ) ||
    (keys.previous !== undefined &&
      (keys.active.version === keys.previous.version ||
        Buffer.from(keys.active.key).equals(Buffer.from(keys.previous.key))))
  )
    throw new Error('invalid leaderboard cursor keys')
}

export function createReportingHandlers(
  repository: ReportingRouteRepository,
  cursorKeys: LeaderboardCursorKeys,
): Pick<KernelHandlers, 'getLeaderboard' | 'getProfile' | 'getSuggestions'> {
  validateKeys(cursorKeys)
  return {
    getSuggestions: async (context) => {
      const actor = authenticated(context)
      const { attemptId } = context.params as AttemptPath
      const { q } = context.query as SuggestionsQuery
      const suggestions = await repository.readAttemptSuggestions(
        actor.guestId,
        attemptId,
        q,
        context.deadline,
      )
      if (suggestions === undefined)
        throw new PublicHttpError('RESOURCE_NOT_FOUND')
      return { status: 200, body: { data: { items: suggestions } } }
    },
    getProfile: async (context) => {
      const actor = authenticated(context)
      const profile = await repository.readProfile(
        actor.guestId,
        context.deadline,
      )
      if (profile === undefined)
        throw new PublicHttpError('AUTHENTICATION_REQUIRED')
      return { status: 200, body: { data: profile } }
    },
    getLeaderboard: async (context) => {
      authenticated(context)
      const { slotId } = context.params as LeaderboardPath
      const query = context.query as LeaderboardQuery
      const page = await repository
        .readDailyLeaderboardPage(
          {
            slotId,
            limit: query.limit === undefined ? 20 : Number(query.limit),
            ...(query.cursor === undefined
              ? {}
              : { cursor: decodeCursor(cursorKeys, slotId, query.cursor) }),
          },
          context.deadline,
        )
        .catch((error: unknown) => {
          if (error instanceof RangeError) throw invalidCursor()
          throw error
        })
      return {
        status: 200,
        body: {
          data: {
            items: page.items,
            nextCursor:
              page.nextPosition === null
                ? null
                : encodeCursor(cursorKeys, slotId, page.nextPosition),
          },
        },
      }
    },
  }
}
