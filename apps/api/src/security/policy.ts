import { API_OPERATIONS } from '@loremaster/contracts'

import type { OperationMiddleware } from '../http/dependencies.js'
import { PublicHttpError } from '../http/errors.js'

function rawHeaderCount(rawHeaders: readonly string[], name: string): number {
  let count = 0
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1
  }
  return count
}

export function createRequestPolicy(origin: string): OperationMiddleware {
  return {
    forOperation(operationId) {
      return (request, _response, next) => {
        const suppliedOrigin = request.headers.origin
        const originCount = rawHeaderCount(request.rawHeaders, 'origin')
        const authentication = API_OPERATIONS[operationId].auth
        const requiresOrigin =
          authentication === 'BOOTSTRAP' ||
          authentication === 'GAMEPLAY_MUTATION'
        if (
          originCount > 1 ||
          (requiresOrigin &&
            (originCount !== 1 || suppliedOrigin !== origin)) ||
          (!requiresOrigin &&
            suppliedOrigin !== undefined &&
            suppliedOrigin !== origin)
        ) {
          next(new PublicHttpError('REQUEST_FORBIDDEN'))
          return
        }
        next()
      }
    },
  }
}
