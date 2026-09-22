import {
  API_ERROR_STATUS,
  API_OPERATIONS,
  type ApiErrorCode,
  type ApiOperationId,
} from '@loremaster/contracts'

import { readCsrfToken, type CookieSource } from './csrf.js'
import { ApiClientError, presentationForApiError } from './errors.js'
import { retryDirective } from './retry.js'

type OperationFor<OperationId extends ApiOperationId> =
  (typeof API_OPERATIONS)[OperationId]
export type ReadOperationId = {
  [
    OperationId in ApiOperationId
  ]: OperationFor<OperationId>['method'] extends 'GET' ? OperationId : never
}[ApiOperationId]
type SchemaOutput<Schema> = Schema extends { readonly _output: infer Output }
  ? Output
  : never

type SchemaRequest<
  OperationId extends ApiOperationId,
  SchemaName extends 'bodySchema' | 'pathSchema' | 'querySchema',
  FieldName extends 'body' | 'path' | 'query',
> =
  OperationFor<OperationId> extends Record<SchemaName, infer Schema>
    ? Readonly<Record<FieldName, SchemaOutput<Schema>>>
    : Readonly<Partial<Record<FieldName, never>>>

type MutationRequest<OperationId extends ApiOperationId> =
  OperationFor<OperationId>['auth'] extends 'GAMEPLAY_MUTATION'
    ? { readonly idempotencyKey: string }
    : { readonly idempotencyKey?: never }

export type ApiClientRequest<OperationId extends ApiOperationId> = Readonly<{
  signal?: AbortSignal
}> &
  SchemaRequest<OperationId, 'bodySchema', 'body'> &
  SchemaRequest<OperationId, 'pathSchema', 'path'> &
  SchemaRequest<OperationId, 'querySchema', 'query'> &
  MutationRequest<OperationId>

export type ApiClientResponse<OperationId extends ApiOperationId> =
  SchemaOutput<OperationFor<OperationId>['successSchema']>

export interface ApiClientEvent {
  readonly operationId: ApiOperationId
  readonly outcome: 'API_ERROR' | 'CLIENT_ERROR' | 'SUCCESS'
  readonly requestId?: string
  readonly status?: number
}

interface ApiClientOptions {
  readonly apiBaseUrl: URL
  readonly browserOrigin?: string
  readonly cookieSource?: CookieSource
  readonly fetchImplementation?: typeof fetch
  readonly observe?: (event: ApiClientEvent) => void
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

interface ValidationSchema {
  safeParse(
    input: unknown,
  ):
    | { readonly data: unknown; readonly success: true }
    | { readonly success: false }
}

type Operation = (typeof API_OPERATIONS)[ApiOperationId]
type RequestRecord = Readonly<Record<string, unknown>>

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu

function defaultBrowserOrigin(): string {
  return window.location.origin
}

function defaultCookieSource(): string {
  return document.cookie
}

function schemaFor(
  operation: Operation,
  name: 'bodySchema' | 'headersSchema' | 'pathSchema' | 'querySchema',
): ValidationSchema | undefined {
  return (operation as unknown as Partial<Record<string, ValidationSchema>>)[
    name
  ]
}

function validated(
  schema: ValidationSchema | undefined,
  value: unknown,
): unknown {
  if (schema === undefined) return undefined
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiClientError('INVALID_CLIENT_REQUEST')
  return result.data
}

function buildPath(operation: Operation, request: RequestRecord): string {
  const pathValues = validated(schemaFor(operation, 'pathSchema'), request.path)
  if (pathValues === undefined) return operation.path
  return operation.path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, key) => {
    const value = (pathValues as Record<string, unknown>)[key]
    if (typeof value !== 'string') {
      throw new ApiClientError('INVALID_CLIENT_REQUEST')
    }
    return encodeURIComponent(value)
  })
}

function appendQuery(
  url: URL,
  operation: Operation,
  request: RequestRecord,
): void {
  const query = validated(schemaFor(operation, 'querySchema'), request.query)
  if (query === undefined) return
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === 'string') url.searchParams.set(key, value)
  }
}

function parseRetryAfter(response: Response): number {
  const raw = response.headers.get('Retry-After')
  if (raw === null || !/^\d+$/u.test(raw)) {
    throw new ApiClientError('MALFORMED_RESPONSE', { status: response.status })
  }
  const seconds = Number(raw)
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new ApiClientError('MALFORMED_RESPONSE', { status: response.status })
  }
  const milliseconds = seconds * 1_000
  if (!Number.isSafeInteger(milliseconds)) {
    throw new ApiClientError('MALFORMED_RESPONSE', { status: response.status })
  }
  return milliseconds
}

async function responseJson(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(response.headers.get('Content-Type') ?? '')) {
    throw new ApiClientError('MALFORMED_RESPONSE', { status: response.status })
  }
  try {
    return await response.json()
  } catch {
    throw new ApiClientError(
      signal?.aborted ? 'CANCELLED' : 'MALFORMED_RESPONSE',
      { status: response.status },
    )
  }
}

function defaultSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiClientError('CANCELLED'))
      return
    }
    const complete = (): void => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }
    const cancel = (): void => {
      globalThis.clearTimeout(timeout)
      reject(new ApiClientError('CANCELLED'))
    }
    const timeout = globalThis.setTimeout(complete, milliseconds)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

export class ApiClient {
  readonly #apiBaseUrl: URL
  readonly #browserOrigin: string
  readonly #cookieSource: CookieSource
  readonly #fetch: typeof fetch
  readonly #observe?: (event: ApiClientEvent) => void
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>

  constructor(options: ApiClientOptions) {
    this.#apiBaseUrl = new URL(options.apiBaseUrl.href)
    this.#browserOrigin = options.browserOrigin ?? defaultBrowserOrigin()
    this.#cookieSource = options.cookieSource ?? defaultCookieSource
    this.#fetch = options.fetchImplementation ?? fetch
    this.#observe = options.observe
    this.#sleep = options.sleep ?? defaultSleep
  }

  async request<OperationId extends ApiOperationId>(
    operationId: OperationId,
    request: ApiClientRequest<OperationId>,
  ): Promise<ApiClientResponse<OperationId>> {
    const operation = API_OPERATIONS[operationId]
    const requestRecord = request as RequestRecord
    const url = new URL(
      buildPath(operation, requestRecord),
      this.#apiBaseUrl.origin,
    )
    appendQuery(url, operation, requestRecord)

    const headers = new Headers()
    let body: string | undefined
    if (schemaFor(operation, 'bodySchema') !== undefined) {
      const bodyValue = validated(
        schemaFor(operation, 'bodySchema'),
        requestRecord.body,
      )
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(bodyValue)
    }
    if (operation.auth === 'GAMEPLAY_MUTATION') {
      headers.set(
        'X-CSRF-Token',
        readCsrfToken(this.#apiBaseUrl, this.#cookieSource),
      )
      if (typeof requestRecord.idempotencyKey !== 'string') {
        throw new ApiClientError('INVALID_CLIENT_REQUEST')
      }
      headers.set('Idempotency-Key', requestRecord.idempotencyKey)
    }

    validated(schemaFor(operation, 'headersSchema'), {
      ...(body === undefined ? {} : { contentType: 'application/json' }),
      ...(operation.auth === 'GAMEPLAY_MUTATION'
        ? {
            csrfToken: headers.get('X-CSRF-Token'),
            idempotencyKey: headers.get('Idempotency-Key'),
          }
        : {}),
      origin: this.#browserOrigin,
    })

    let response: Response
    try {
      response = await this.#fetch(url, {
        method: operation.method,
        credentials: 'include',
        headers,
        ...(body === undefined ? {} : { body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch {
      const error = new ApiClientError(
        request.signal?.aborted ? 'CANCELLED' : 'NETWORK_ERROR',
      )
      this.#observe?.({ operationId, outcome: 'CLIENT_ERROR' })
      throw error
    }

    const payload = await responseJson(response, request.signal).catch(
      (error: unknown) => {
        this.#observe?.({
          operationId,
          outcome: 'CLIENT_ERROR',
          status: response.status,
        })
        throw error
      },
    )

    if (response.status === operation.successStatus) {
      const parsed = operation.successSchema.safeParse(payload)
      if (!parsed.success) {
        this.#observe?.({
          operationId,
          outcome: 'CLIENT_ERROR',
          status: response.status,
        })
        throw new ApiClientError('MALFORMED_RESPONSE', {
          status: response.status,
        })
      }
      this.#observe?.({
        operationId,
        outcome: 'SUCCESS',
        status: response.status,
      })
      return parsed.data as ApiClientResponse<OperationId>
    }

    const errorStatuses = operation.errorStatuses as readonly number[]
    const parsedError = operation.errorSchema.safeParse(payload)
    if (
      !errorStatuses.includes(response.status) ||
      !parsedError.success ||
      API_ERROR_STATUS[parsedError.data.error.code] !== response.status
    ) {
      this.#observe?.({
        operationId,
        outcome: 'CLIENT_ERROR',
        status: response.status,
      })
      throw new ApiClientError('MALFORMED_RESPONSE', {
        status: response.status,
      })
    }

    const { code, requestId } = parsedError.data.error
    const details = {
      apiCode: code as ApiErrorCode,
      presentation: presentationForApiError(code),
      requestId,
      status: response.status,
    }
    const error =
      code === 'RATE_LIMITED'
        ? new ApiClientError('RATE_LIMITED', {
            ...details,
            retryAfterMilliseconds: parseRetryAfter(response),
          })
        : new ApiClientError('API_ERROR', details)
    this.#observe?.({
      operationId,
      outcome: 'API_ERROR',
      requestId,
      status: response.status,
    })
    throw error
  }

  async requestReadWithRetry<OperationId extends ReadOperationId>(
    operationId: OperationId,
    request: ApiClientRequest<OperationId>,
    maximumAttempts = 3,
  ): Promise<ApiClientResponse<OperationId>> {
    const operation = API_OPERATIONS[operationId]
    if (operation.method !== 'GET') {
      throw new ApiClientError('INVALID_CLIENT_REQUEST')
    }
    const attempts = Math.max(1, Math.min(maximumAttempts, 5))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.request(operationId, request)
      } catch (error) {
        if (!(error instanceof ApiClientError) || attempt + 1 >= attempts) {
          throw error
        }
        const directive = retryDirective(operationId, error, attempt)
        if (directive.kind !== 'AUTOMATIC_RETRY') throw error
        await this.#sleep(directive.delayMilliseconds, request.signal)
      }
    }
    throw new ApiClientError('NETWORK_ERROR')
  }
}
