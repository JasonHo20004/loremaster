import type { CookieConfiguration } from '@loremaster/config'
import type { Request } from 'express'

import { API_OPERATIONS } from '@loremaster/contracts'
import type { DeadlineContext } from '@loremaster/database'

import type {
  AuthenticatedIdentity,
  AuthenticatedSession,
  AuthenticationControl,
  Clock,
  DeadlineControl,
} from '../http/dependencies.js'
import { PublicHttpError } from '../http/errors.js'
import { clearSessionCookies, readUniqueCookie } from './cookies.js'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export interface SessionSecurityStore {
  authenticate(
    authenticationToken: string,
    deadline: DeadlineContext,
  ): Promise<AuthenticatedSession | null>
  verifyCsrfToken(session: AuthenticatedSession, csrfToken: string): boolean
}

export function createAuthenticationControl(options: {
  readonly cookies: {
    readonly csrf: CookieConfiguration
    readonly session: CookieConfiguration
  }
  readonly clock: Clock
  readonly deadline: DeadlineControl
  readonly sessions: SessionSecurityStore
}): AuthenticationControl {
  const sessionsByRequest = new WeakMap<Request, AuthenticatedSession>()

  return {
    identityFor(request): AuthenticatedIdentity | undefined {
      const session = sessionsByRequest.get(request)
      if (session === undefined) return undefined
      return {
        expiresAt: session.expiresAt,
        guestId: session.guestId,
        pseudonym: session.pseudonym,
        sessionId: session.sessionId,
      }
    },
    sessionFor: (request) => sessionsByRequest.get(request),
    forOperation(operationId) {
      if (
        API_OPERATIONS[operationId].auth === 'NONE' ||
        API_OPERATIONS[operationId].auth === 'BOOTSTRAP'
      ) {
        return (_request, _response, next) => next()
      }

      return async (request, response, next) => {
        const authenticationToken = readUniqueCookie(
          request,
          options.cookies.session.name,
        )
        if (
          authenticationToken == null ||
          !TOKEN_PATTERN.test(authenticationToken)
        ) {
          clearSessionCookies(response, options.cookies)
          next(new PublicHttpError('AUTHENTICATION_REQUIRED'))
          return
        }

        try {
          const identity = await options.sessions.authenticate(
            authenticationToken,
            options.deadline.contextFor(request),
          )
          if (
            identity === null ||
            identity.expiresAt.getTime() <= options.clock.now()
          ) {
            clearSessionCookies(response, options.cookies)
            next(new PublicHttpError('AUTHENTICATION_REQUIRED'))
            return
          }
          sessionsByRequest.set(request, identity)
          next()
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            (error as { readonly code?: unknown }).code === 'DATABASE_TIMEOUT'
          ) {
            next(error)
            return
          }
          next(new PublicHttpError('SERVICE_UNAVAILABLE'))
        }
      }
    },
  }
}
