import type { ServerConfiguration } from '@loremaster/config'
import { digestLimitIdentity, type SharedLimiter } from '@loremaster/cache'

import { API_OPERATIONS, type ApiOperationId } from '@loremaster/contracts'

import type {
  AuthenticationControl,
  Clock,
  OperationMiddleware,
} from '../http/dependencies.js'
import { PublicHttpError } from '../http/errors.js'
import type { SourceIpResolver } from './source-ip.js'

type Counter = 'autocomplete' | 'mutation' | 'session'

interface Entry {
  autocomplete: number
  mutation: number
  session: number
}

interface WindowStore {
  bucket: number
  readonly capacity: number
  readonly entries: Map<string, Entry>
}

interface LimitCheck {
  readonly counter: Counter
  readonly identity: string
  readonly limit: number
  readonly store: WindowStore
}

function emptyEntry(): Entry {
  return { autocomplete: 0, mutation: 0, session: 0 }
}

function category(operationId: ApiOperationId): Counter | undefined {
  if (operationId === 'createSession') return 'session'
  if (operationId === 'getSuggestions') return 'autocomplete'
  if (API_OPERATIONS[operationId].auth === 'GAMEPLAY_MUTATION')
    return 'mutation'
  return undefined
}

/**
 * This bounded fallback is intentionally replica-local. The optional shared
 * limiter runs after it; a local denial is always final.
 */
export function createRateLimitControl(options: {
  readonly auth: AuthenticationControl
  readonly clock: Clock
  readonly config: ServerConfiguration['limiter']
  readonly sourceIp: SourceIpResolver
  readonly shared?: {
    readonly limiter: SharedLimiter
    readonly hmacKey: Uint8Array
    readonly onDegraded?: () => void
  }
}): OperationMiddleware {
  const ipStore: WindowStore = {
    bucket: -1,
    capacity: options.config.ipCapacity,
    entries: new Map(),
  }
  const guestStore: WindowStore = {
    bucket: -1,
    capacity: options.config.guestCapacity,
    entries: new Map(),
  }

  return {
    forOperation(operationId) {
      const counter = category(operationId)
      if (counter === undefined) {
        return (_request, _response, next) => next()
      }

      return async (request, response, next) => {
        try {
          const now = options.clock.now()
          const bucket = Math.floor(now / options.config.windowMs)
          for (const store of [ipStore, guestStore]) {
            if (store.bucket !== bucket) {
              store.entries.clear()
              store.bucket = bucket
            }
          }

          const ip = options.sourceIp.sourceIpFor(request)
          const checks: LimitCheck[] = [
            {
              counter,
              identity: ip,
              limit:
                counter === 'session'
                  ? options.config.sessionCreationsPerIp
                  : counter === 'autocomplete'
                    ? options.config.autocompletePerIp
                    : options.config.mutationsPerIp,
              store: ipStore,
            },
          ]
          if (counter !== 'session') {
            const identity = options.auth.identityFor(request)
            if (identity === undefined) {
              throw new PublicHttpError('AUTHENTICATION_REQUIRED')
            }
            checks.push({
              counter,
              identity: identity.guestId,
              limit:
                counter === 'autocomplete'
                  ? options.config.autocompletePerGuest
                  : options.config.mutationsPerGuest,
              store: guestStore,
            })
          }

          const denied = checks.some(
            ({ counter: key, identity, limit, store }) => {
              const entry = store.entries.get(identity)
              return (
                (entry === undefined && store.entries.size >= store.capacity) ||
                (entry?.[key] ?? 0) >= limit
              )
            },
          )
          if (denied) {
            const resetAt = (bucket + 1) * options.config.windowMs
            response.setHeader(
              'Retry-After',
              String(Math.max(1, Math.ceil((resetAt - now) / 1_000))),
            )
            next(new PublicHttpError('RATE_LIMITED'))
            return
          }

          for (const { counter: key, identity, store } of checks) {
            const entry = store.entries.get(identity) ?? emptyEntry()
            entry[key] += 1
            store.entries.set(identity, entry)
          }
          if (options.shared !== undefined) {
            let decision
            try {
              decision = await options.shared.limiter.consume({
                counter,
                ipDigest: digestLimitIdentity(options.shared.hmacKey, 'ip', ip),
                ...(checks.length === 2
                  ? {
                      guestDigest: digestLimitIdentity(
                        options.shared.hmacKey,
                        'guest',
                        checks[1]!.identity,
                      ),
                    }
                  : {}),
              })
            } catch {
              decision = {
                state: 'degraded' as const,
                retryAfterSeconds: 0 as const,
              }
            }
            if (decision.state === 'degraded') options.shared.onDegraded?.()
            if (decision.state === 'denied') {
              response.setHeader(
                'Retry-After',
                String(decision.retryAfterSeconds),
              )
              next(new PublicHttpError('RATE_LIMITED'))
              return
            }
          }
          next()
        } catch (error) {
          next(error)
        }
      }
    },
  }
}
