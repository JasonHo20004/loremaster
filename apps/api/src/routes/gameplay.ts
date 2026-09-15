import {
  GAMEPLAY_REJECTION_HTTP,
  type ApiErrorCode,
} from '@loremaster/contracts'
import type {
  DeadlineContext,
  Database,
  GameplayCommandRequest,
  GameplayCommandResult,
  StartAttemptRequest,
  StartAttemptResult,
} from '@loremaster/database'
import {
  executeGameplayCommand,
  readCurrentCase,
  readOwnedAttempt,
  startCurrentAttempt,
} from '@loremaster/database'

import type {
  AuthenticatedIdentity,
  KernelHandlerContext,
  KernelHandlers,
} from '../http/dependencies.js'
import { PublicHttpError } from '../http/errors.js'

interface AttemptPath {
  readonly attemptId: string
}

interface CommandBody {
  readonly command: GameplayCommandRequest['command']
  readonly expectedVersion: number
}

interface MutationHeaders {
  readonly idempotencyKey: string
}

export interface GameplayRouteRepository {
  executeGameplayCommand(
    request: GameplayCommandRequest,
    deadline: DeadlineContext,
  ): Promise<GameplayCommandResult>
  readCurrentCase(guestId: string, deadline: DeadlineContext): Promise<unknown>
  readOwnedAttempt(
    guestId: string,
    attemptId: string,
    deadline: DeadlineContext,
  ): Promise<unknown | undefined>
  startCurrentAttempt(
    request: StartAttemptRequest,
    deadline: DeadlineContext,
  ): Promise<StartAttemptResult>
}

export function createDatabaseGameplayRepository(
  database: Database,
): GameplayRouteRepository {
  return {
    executeGameplayCommand: (request, deadline) =>
      executeGameplayCommand(database, request, deadline),
    readCurrentCase: (guestId, deadline) =>
      readCurrentCase(database, guestId, deadline),
    readOwnedAttempt: (guestId, attemptId, deadline) =>
      readOwnedAttempt(database, guestId, attemptId, deadline),
    startCurrentAttempt: (request, deadline) =>
      startCurrentAttempt(database, request, deadline),
  }
}

function identity(context: KernelHandlerContext): AuthenticatedIdentity {
  if (context.identity === undefined)
    throw new PublicHttpError('AUTHENTICATION_REQUIRED')
  return context.identity
}

function rejectGameplay(code: keyof typeof GAMEPLAY_REJECTION_HTTP): never {
  const mapping = GAMEPLAY_REJECTION_HTTP[code]
  throw new PublicHttpError(mapping.code as ApiErrorCode)
}

export function createGameplayHandlers(
  repository: GameplayRouteRepository,
): Pick<
  KernelHandlers,
  | 'getCurrentCase'
  | 'getOwnedAttempt'
  | 'runGameplayCommand'
  | 'startCurrentAttempt'
> {
  return {
    getCurrentCase: async (context) => {
      const actor = identity(context)
      return {
        status: 200,
        body: {
          data: await repository.readCurrentCase(
            actor.guestId,
            context.deadline,
          ),
        },
      }
    },
    getOwnedAttempt: async (context) => {
      const actor = identity(context)
      const { attemptId } = context.params as AttemptPath
      const attempt = await repository.readOwnedAttempt(
        actor.guestId,
        attemptId,
        context.deadline,
      )
      if (attempt === undefined) throw new PublicHttpError('RESOURCE_NOT_FOUND')
      return { status: 200, body: { data: attempt } }
    },
    startCurrentAttempt: async (context) => {
      const actor = identity(context)
      const { idempotencyKey } = context.headers as MutationHeaders
      const result = await repository.startCurrentAttempt(
        {
          guestId: actor.guestId,
          sessionId: actor.sessionId,
          idempotencyKey,
        },
        context.deadline,
      )
      if (!result.ok) rejectGameplay(result.code)
      return {
        status: 200,
        body: {
          data: {
            outcomeCode: result.outcomeCode,
            replayed: result.replayed,
            attempt: result.projection,
          },
        },
      }
    },
    runGameplayCommand: async (context) => {
      const actor = identity(context)
      const { attemptId } = context.params as AttemptPath
      const { idempotencyKey } = context.headers as MutationHeaders
      const body = context.body as CommandBody
      const result = await repository.executeGameplayCommand(
        {
          attemptId,
          guestId: actor.guestId,
          sessionId: actor.sessionId,
          idempotencyKey,
          expectedVersion: body.expectedVersion,
          command: body.command,
        },
        context.deadline,
      )
      if (!result.ok) rejectGameplay(result.code)
      return {
        status: 200,
        body: {
          data: {
            outcomeCode: result.outcomeCode,
            replayed: result.replayed,
            attempt: result.projection,
          },
        },
      }
    },
  }
}
