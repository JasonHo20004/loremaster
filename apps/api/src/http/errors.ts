import type { Response } from 'express'

import {
  API_ERROR_STATUS,
  PUBLIC_ERROR_FIELD_PATHS,
  type ApiErrorCode,
} from '@loremaster/contracts'

export type PublicFieldCode =
  | 'REQUIRED'
  | 'INVALID_TYPE'
  | 'INVALID_FORMAT'
  | 'OUT_OF_BOUNDS'
  | 'UNKNOWN_FIELD'
  | 'DUPLICATE_FIELD'

export interface PublicFieldError {
  readonly code: PublicFieldCode
  readonly path: string
}

export class PublicHttpError extends Error {
  readonly code: ApiErrorCode
  readonly fields?: readonly PublicFieldError[]
  readonly status: number

  constructor(code: ApiErrorCode, fields?: readonly PublicFieldError[]) {
    super(code)
    this.name = 'PublicHttpError'
    this.code = code
    this.status = API_ERROR_STATUS[code]
    if (fields !== undefined && fields.length > 0) this.fields = fields
  }
}

export function sendPublicError(
  response: Response,
  requestId: string,
  error: PublicHttpError,
): void {
  const allowedPaths = new Set<string>(PUBLIC_ERROR_FIELD_PATHS)
  const fields = error.fields?.slice(0, 32).map((field) => ({
    code: field.code,
    path: allowedPaths.has(field.path) ? field.path : '$',
  }))
  response.status(error.status).json({
    error: {
      code: error.code,
      requestId,
      ...(fields === undefined || fields.length === 0 ? {} : { fields }),
    },
  })
}
