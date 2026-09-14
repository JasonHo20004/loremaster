import type { z } from 'zod'

import {
  attemptPathSchema,
  attemptResponseSchema,
  bootstrapHeadersSchema,
  caseResponseSchema,
  commandResponseSchema,
  errorResponseSchema,
  gameplayCommandRequestSchema,
  healthResponseSchema,
  leaderboardPathSchema,
  leaderboardQuerySchema,
  leaderboardResponseSchema,
  mutationHeadersSchema,
  profileResponseSchema,
  sessionBootstrapRequestSchema,
  sessionResponseSchema,
  startAttemptResponseSchema,
  suggestionsQuerySchema,
  suggestionsResponseSchema,
} from './schemas.js'

type HttpMethod = 'GET' | 'POST'
type AuthenticationPolicy =
  'NONE' | 'BOOTSTRAP' | 'SESSION' | 'GAMEPLAY_MUTATION'
type ErrorStatus =
  400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503 | 504

interface ApiOperation {
  readonly operationId: string
  readonly method: HttpMethod
  readonly path: string
  readonly auth: AuthenticationPolicy
  readonly successStatus: 200 | 201
  readonly bodySchema?: z.ZodType
  readonly headersSchema?: z.ZodType
  readonly pathSchema?: z.ZodType
  readonly querySchema?: z.ZodType
  readonly successSchema: z.ZodType
  readonly errorSchema: typeof errorResponseSchema
  readonly errorStatuses: readonly ErrorStatus[]
}

function operation<const Operation extends ApiOperation>(
  value: Operation,
): Operation {
  return value
}

const COMMON_ERRORS = [401, 403, 500, 503] as const
const MUTATION_ERRORS = [
  400,
  ...COMMON_ERRORS,
  409,
  413,
  415,
  429,
  504,
] as const

export const API_OPERATIONS = Object.freeze({
  createSession: operation({
    operationId: 'createSession',
    method: 'POST',
    path: '/api/v1/session',
    auth: 'BOOTSTRAP',
    successStatus: 201,
    bodySchema: sessionBootstrapRequestSchema,
    headersSchema: bootstrapHeadersSchema,
    successSchema: sessionResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: [400, 403, 413, 415, 429, 500, 503],
  }),
  getSession: operation({
    operationId: 'getSession',
    method: 'GET',
    path: '/api/v1/session',
    auth: 'SESSION',
    successStatus: 200,
    successSchema: sessionResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: COMMON_ERRORS,
  }),
  getCurrentCase: operation({
    operationId: 'getCurrentCase',
    method: 'GET',
    path: '/api/v1/cases/current',
    auth: 'SESSION',
    successStatus: 200,
    successSchema: caseResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: COMMON_ERRORS,
  }),
  startCurrentAttempt: operation({
    operationId: 'startCurrentAttempt',
    method: 'POST',
    path: '/api/v1/cases/current/attempt',
    auth: 'GAMEPLAY_MUTATION',
    successStatus: 200,
    bodySchema: sessionBootstrapRequestSchema,
    headersSchema: mutationHeadersSchema,
    successSchema: startAttemptResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: MUTATION_ERRORS,
  }),
  getOwnedAttempt: operation({
    operationId: 'getOwnedAttempt',
    method: 'GET',
    path: '/api/v1/attempts/:attemptId',
    auth: 'SESSION',
    successStatus: 200,
    pathSchema: attemptPathSchema,
    successSchema: attemptResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: [400, ...COMMON_ERRORS, 404],
  }),
  runGameplayCommand: operation({
    operationId: 'runGameplayCommand',
    method: 'POST',
    path: '/api/v1/attempts/:attemptId/commands',
    auth: 'GAMEPLAY_MUTATION',
    successStatus: 200,
    bodySchema: gameplayCommandRequestSchema,
    headersSchema: mutationHeadersSchema,
    pathSchema: attemptPathSchema,
    successSchema: commandResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: MUTATION_ERRORS,
  }),
  getSuggestions: operation({
    operationId: 'getSuggestions',
    method: 'GET',
    path: '/api/v1/attempts/:attemptId/suggestions',
    auth: 'SESSION',
    successStatus: 200,
    pathSchema: attemptPathSchema,
    querySchema: suggestionsQuerySchema,
    successSchema: suggestionsResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: [400, ...COMMON_ERRORS, 404, 429],
  }),
  getProfile: operation({
    operationId: 'getProfile',
    method: 'GET',
    path: '/api/v1/profile',
    auth: 'SESSION',
    successStatus: 200,
    successSchema: profileResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: COMMON_ERRORS,
  }),
  getLeaderboard: operation({
    operationId: 'getLeaderboard',
    method: 'GET',
    path: '/api/v1/leaderboards/:slotId',
    auth: 'SESSION',
    successStatus: 200,
    pathSchema: leaderboardPathSchema,
    querySchema: leaderboardQuerySchema,
    successSchema: leaderboardResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: [400, ...COMMON_ERRORS],
  }),
  healthLive: operation({
    operationId: 'healthLive',
    method: 'GET',
    path: '/health/live',
    auth: 'NONE',
    successStatus: 200,
    successSchema: healthResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: [500],
  }),
  healthReady: operation({
    operationId: 'healthReady',
    method: 'GET',
    path: '/health/ready',
    auth: 'NONE',
    successStatus: 200,
    successSchema: healthResponseSchema,
    errorSchema: errorResponseSchema,
    errorStatuses: [500, 503],
  }),
})

export type ApiOperationId = keyof typeof API_OPERATIONS
