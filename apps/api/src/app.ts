import { randomUUID } from 'node:crypto'

import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import {
  API_OPERATIONS,
  PUBLIC_ERROR_FIELD_PATHS,
  type ApiOperationId,
} from '@loremaster/contracts'

import type {
  KernelDependencies,
  KernelHandlerContext,
} from './http/dependencies.js'
import {
  PublicHttpError,
  sendPublicError,
  type PublicFieldCode,
  type PublicFieldError,
} from './http/errors.js'
import { parseBoundedJsonBody } from './http/raw-json.js'

type FrozenOperation = (typeof API_OPERATIONS)[ApiOperationId]
type SchemaKey = 'bodySchema' | 'headersSchema' | 'pathSchema' | 'querySchema'

interface ValidationIssue {
  readonly code: string
  readonly input?: unknown
  readonly path: readonly PropertyKey[]
}

interface ValidationError {
  readonly issues: readonly ValidationIssue[]
}

interface ValidationSchema {
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false; readonly error: ValidationError }
}

interface RequestState {
  body: unknown
  headers: unknown
  params: unknown
  query: unknown
  readonly receivedAt: number
  readonly requestId: string
}

const requestState = new WeakMap<Request, RequestState>()
const publicPaths = new Set<string>(PUBLIC_ERROR_FIELD_PATHS)
const securityHeaders = new Set([
  'content-type',
  'idempotency-key',
  'origin',
  'x-csrf-token',
])

function stateFor(request: Request): RequestState {
  const state = requestState.get(request)
  if (state === undefined) throw new PublicHttpError('INTERNAL_ERROR')
  return state
}

function headerCount(request: Request, target: string): number {
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === target) count += 1
  }
  return count
}

function safePath(path: readonly PropertyKey[], prefix?: string): string {
  const segments = [
    ...(prefix === undefined ? [] : [prefix]),
    ...path.map(String),
  ]
  const candidate = segments.length === 0 ? '$' : `$.${segments.join('.')}`
  return publicPaths.has(candidate) ? candidate : '$'
}

function issueCode(issue: ValidationIssue): PublicFieldCode {
  if (issue.code === 'unrecognized_keys') return 'UNKNOWN_FIELD'
  if (issue.code === 'invalid_type') {
    return issue.input === undefined ? 'REQUIRED' : 'INVALID_TYPE'
  }
  if (issue.code === 'too_big' || issue.code === 'too_small') {
    return 'OUT_OF_BOUNDS'
  }
  return 'INVALID_FORMAT'
}

function validationError(
  error: ValidationError,
  prefix?: string,
): PublicHttpError {
  const fields = error.issues.slice(0, 32).map<PublicFieldError>((issue) => ({
    path: safePath(issue.path, prefix),
    code: issueCode(issue),
  }))
  return new PublicHttpError('INVALID_REQUEST', fields)
}

function schemaFor(
  operation: FrozenOperation,
  key: SchemaKey,
): ValidationSchema | undefined {
  const schemas = operation as unknown as Partial<
    Readonly<Record<SchemaKey, ValidationSchema>>
  >
  return schemas[key]
}

function normalizedHeaders(
  request: Request,
  operation: FrozenOperation,
): Record<string, unknown> {
  if (operation.auth === 'BOOTSTRAP') {
    return {
      contentType: request.headers['content-type'],
      origin: request.headers.origin,
    }
  }
  return {
    contentType: request.headers['content-type'],
    csrfToken: request.headers['x-csrf-token'],
    idempotencyKey: request.headers['idempotency-key'],
    origin: request.headers.origin,
  }
}

function rejectRepeatedQueryParameters(request: Request): void {
  const counts = new Map<string, number>()
  const parameters = new URL(request.originalUrl, 'http://kernel.invalid')
    .searchParams
  for (const key of parameters.keys())
    counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const [key, count] of counts) {
    if (count < 2) continue
    const path = `$.${key}`
    throw new PublicHttpError('INVALID_REQUEST', [
      {
        path: publicPaths.has(path) ? path : '$',
        code: 'DUPLICATE_FIELD',
      },
    ])
  }
}

function rejectRepeatedSecurityHeaders(request: Request): void {
  for (const header of securityHeaders) {
    if (headerCount(request, header) > 1) {
      const path =
        header === 'x-csrf-token'
          ? '$.headers.csrfToken'
          : `$.headers.${header.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())}`
      throw new PublicHttpError('INVALID_REQUEST', [
        {
          path: publicPaths.has(path) ? path : '$',
          code: 'DUPLICATE_FIELD',
        },
      ])
    }
  }
}

function parseWithSchema(
  schema: ValidationSchema | undefined,
  input: unknown,
  prefix?: string,
): unknown {
  if (schema === undefined) return undefined
  const result = schema.safeParse(input)
  if (!result.success) throw validationError(result.error, prefix)
  return result.data
}

function requestValidator(operation: FrozenOperation): RequestHandler {
  return async (request, _response, next) => {
    try {
      rejectRepeatedSecurityHeaders(request)
      rejectRepeatedQueryParameters(request)
      const bodySchema = schemaFor(operation, 'bodySchema')
      if (bodySchema !== undefined) {
        if (request.headers['content-type'] !== 'application/json') {
          request.resume()
          throw new PublicHttpError('UNSUPPORTED_MEDIA_TYPE')
        }
      }
      const state = stateFor(request)
      state.body =
        bodySchema === undefined
          ? undefined
          : parseWithSchema(bodySchema, await parseBoundedJsonBody(request))
      state.headers = parseWithSchema(
        schemaFor(operation, 'headersSchema'),
        normalizedHeaders(request, operation),
        'headers',
      )
      state.params = parseWithSchema(
        schemaFor(operation, 'pathSchema'),
        request.params,
      )
      state.query = parseWithSchema(
        schemaFor(operation, 'querySchema'),
        request.query,
      )
      next()
    } catch (error) {
      next(error)
    }
  }
}

function invokeHandler(
  operationId: ApiOperationId,
  dependencies: KernelDependencies,
): RequestHandler {
  const operation = API_OPERATIONS[operationId]
  const handler = dependencies.handlers[operationId]
  if (handler === undefined)
    throw new Error(`Missing handler for ${operationId}`)
  return async (request, response, next) => {
    try {
      const state = stateFor(request)
      const context: KernelHandlerContext = {
        body: state.body,
        clock: dependencies.clock,
        headers: state.headers,
        operationId,
        params: state.params,
        query: state.query,
        receivedAt: state.receivedAt,
        repository: dependencies.repository,
        request,
        requestId: state.requestId,
      }
      const result = await handler(context)
      if (result.status !== operation.successStatus) {
        throw new PublicHttpError('INTERNAL_ERROR')
      }
      const output = operation.successSchema.safeParse(result.body)
      if (!output.success) throw new PublicHttpError('INTERNAL_ERROR')
      response.status(result.status).json(output.data)
    } catch (error) {
      next(error)
    }
  }
}

function registerOperation(
  application: Express,
  operationId: ApiOperationId,
  dependencies: KernelDependencies,
): void {
  const operation = API_OPERATIONS[operationId]
  if (dependencies.handlers[operationId] === undefined) return
  const middleware = [
    dependencies.controls.policy.forOperation(operationId),
    dependencies.controls.limiter.forOperation(operationId),
    dependencies.controls.auth.forOperation(operationId),
    requestValidator(operation),
    invokeHandler(operationId, dependencies),
  ]
  if (operation.method === 'GET') application.get(operation.path, ...middleware)
  else application.post(operation.path, ...middleware)
}

function errorHandler(): ErrorRequestHandler {
  return (
    error: unknown,
    request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    void _next
    const state = requestState.get(request)
    const requestId = state?.requestId ?? randomUUID()
    sendPublicError(
      response,
      requestId,
      error instanceof PublicHttpError
        ? error
        : new PublicHttpError('INTERNAL_ERROR'),
    )
  }
}

export function createApplication(dependencies: KernelDependencies): Express {
  const application = express()
  application.disable('x-powered-by')
  application.disable('etag')
  application.set('json escape', true)
  application.set('query parser', 'simple')
  application.use((request, response, next) => {
    const requestId = randomUUID()
    requestState.set(request, {
      body: undefined,
      headers: undefined,
      params: undefined,
      query: undefined,
      receivedAt: dependencies.clock.now(),
      requestId,
    })
    response.setHeader('X-Request-ID', requestId)
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    )
    response.setHeader(
      'Permissions-Policy',
      'camera=(), geolocation=(), microphone=()',
    )
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    next()
  })
  application.use(dependencies.controls.deadline)
  application.use(dependencies.controls.logger)

  for (const operationId of Object.keys(API_OPERATIONS) as ApiOperationId[]) {
    registerOperation(application, operationId, dependencies)
  }

  application.use((_request, _response, next) => {
    next(new PublicHttpError('RESOURCE_NOT_FOUND'))
  })
  application.use(errorHandler())
  return application
}
