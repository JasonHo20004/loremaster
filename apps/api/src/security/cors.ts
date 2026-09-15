import type { NextFunction, RequestHandler } from 'express'

import { PublicHttpError } from '../http/errors.js'

const ALLOWED_HEADERS = [
  'Content-Type',
  'Idempotency-Key',
  'X-CSRF-Token',
] as const
const ALLOWED_HEADER_NAMES = new Set(
  ALLOWED_HEADERS.map((header) => header.toLowerCase()),
)
const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'] as const
const ALLOWED_METHOD_NAMES = new Set<string>(ALLOWED_METHODS)

function rawHeaderCount(rawHeaders: readonly string[], name: string): number {
  let count = 0
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1
  }
  return count
}

function deny(next: NextFunction): void {
  next(new PublicHttpError('REQUEST_FORBIDDEN'))
}

export function createCorsMiddleware(allowedOrigin: string): RequestHandler {
  return (request, response, next) => {
    response.vary('Origin')
    const origin = request.headers.origin
    const originCount = rawHeaderCount(request.rawHeaders, 'origin')
    if (originCount > 1 || (origin !== undefined && origin !== allowedOrigin)) {
      deny(next)
      return
    }

    if (origin === allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', allowedOrigin)
      response.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    if (request.method !== 'OPTIONS') {
      next()
      return
    }

    const requestedMethod = request.headers['access-control-request-method']
    const requestedHeaders = request.headers['access-control-request-headers']
    if (
      origin !== allowedOrigin ||
      rawHeaderCount(request.rawHeaders, 'access-control-request-method') !==
        1 ||
      typeof requestedMethod !== 'string' ||
      !ALLOWED_METHOD_NAMES.has(requestedMethod) ||
      rawHeaderCount(request.rawHeaders, 'access-control-request-headers') >
        1 ||
      Array.isArray(requestedHeaders)
    ) {
      deny(next)
      return
    }

    const requestedHeaderNames =
      requestedHeaders === undefined
        ? []
        : requestedHeaders
            .split(',')
            .map((header) => header.trim().toLowerCase())
    if (
      requestedHeaderNames.some(
        (header) => header === '' || !ALLOWED_HEADER_NAMES.has(header),
      ) ||
      new Set(requestedHeaderNames).size !== requestedHeaderNames.length
    ) {
      deny(next)
      return
    }

    response.setHeader(
      'Access-Control-Allow-Methods',
      ALLOWED_METHODS.join(', '),
    )
    response.setHeader(
      'Access-Control-Allow-Headers',
      ALLOWED_HEADERS.join(', '),
    )
    response.status(204).end()
  }
}
