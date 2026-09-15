import type { Request, RequestHandler, Response } from 'express'

import type { ApiOperationId } from '@loremaster/contracts'
import type { DeadlineContext } from '@loremaster/database'

export interface Clock {
  now(): number
}

export type ApiRepository = object

export interface AuthenticatedIdentity {
  readonly expiresAt: Date
  readonly guestId: string
  readonly pseudonym: string
  readonly sessionId: string
}

export interface AuthenticatedSession extends AuthenticatedIdentity {
  readonly csrfHash: Uint8Array
}

export interface OperationMiddleware {
  forOperation(operationId: ApiOperationId): RequestHandler
}

export interface AuthenticationControl extends OperationMiddleware {
  identityFor(request: Request): AuthenticatedIdentity | undefined
  sessionFor(request: Request): AuthenticatedSession | undefined
}

export interface DeadlineControl {
  readonly middleware: RequestHandler
  contextFor(request: Request): DeadlineContext
}

export interface KernelControls {
  readonly auth: AuthenticationControl
  readonly cors: RequestHandler
  readonly csrf: OperationMiddleware
  readonly deadline: DeadlineControl
  readonly limiter: OperationMiddleware
  readonly logger: RequestHandler
  readonly policy: OperationMiddleware
}

export interface KernelHandlerContext {
  readonly body: unknown
  readonly clock: Clock
  readonly deadline: DeadlineContext
  readonly headers: unknown
  readonly identity?: AuthenticatedIdentity
  readonly operationId: ApiOperationId
  readonly params: unknown
  readonly query: unknown
  readonly receivedAt: number
  readonly repository: ApiRepository
  readonly request: Request
  readonly response: Response
  readonly requestId: string
}

export interface KernelHandlerResult {
  readonly body: unknown
  readonly status: 200 | 201
}

export type KernelHandler = (
  context: KernelHandlerContext,
) => KernelHandlerResult | Promise<KernelHandlerResult>

export type KernelHandlers = Partial<
  Readonly<Record<ApiOperationId, KernelHandler>>
>

export interface KernelDependencies {
  readonly clock: Clock
  readonly controls: KernelControls
  readonly handlers: KernelHandlers
  readonly repository: ApiRepository
}
