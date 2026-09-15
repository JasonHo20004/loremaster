import type { Request, RequestHandler } from 'express'

import type { ApiOperationId } from '@loremaster/contracts'

export interface Clock {
  now(): number
}

export type ApiRepository = object

export interface OperationMiddleware {
  forOperation(operationId: ApiOperationId): RequestHandler
}

export interface KernelControls {
  readonly auth: OperationMiddleware
  readonly deadline: RequestHandler
  readonly limiter: OperationMiddleware
  readonly logger: RequestHandler
  readonly policy: OperationMiddleware
}

export interface KernelHandlerContext {
  readonly body: unknown
  readonly clock: Clock
  readonly headers: unknown
  readonly operationId: ApiOperationId
  readonly params: unknown
  readonly query: unknown
  readonly receivedAt: number
  readonly repository: ApiRepository
  readonly request: Request
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
