import { timingSafeEqual } from 'node:crypto'

import type { CookieConfiguration } from '@loremaster/config'

import type {
  AuthenticationControl,
  OperationMiddleware,
} from '../http/dependencies.js'
import { PublicHttpError } from '../http/errors.js'
import type { SessionSecurityStore } from './auth.js'
import { readUniqueCookie } from './cookies.js'

import { API_OPERATIONS } from '@loremaster/contracts'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

export function createCsrfControl(options: {
  readonly auth: AuthenticationControl
  readonly csrfCookie: CookieConfiguration
  readonly sessions: SessionSecurityStore
}): OperationMiddleware {
  return {
    forOperation(operationId) {
      if (API_OPERATIONS[operationId].auth !== 'GAMEPLAY_MUTATION') {
        return (_request, _response, next) => next()
      }

      return (request, _response, next) => {
        const session = options.auth.sessionFor(request)
        const cookieToken = readUniqueCookie(request, options.csrfCookie.name)
        const headerToken = request.headers['x-csrf-token']
        if (
          session === undefined ||
          typeof headerToken !== 'string' ||
          cookieToken == null ||
          !TOKEN_PATTERN.test(headerToken) ||
          !TOKEN_PATTERN.test(cookieToken) ||
          !tokensEqual(headerToken, cookieToken) ||
          !options.sessions.verifyCsrfToken(session, headerToken)
        ) {
          next(new PublicHttpError('REQUEST_FORBIDDEN'))
          return
        }
        next()
      }
    },
  }
}
