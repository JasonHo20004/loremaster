import type { Request } from 'express'

import type { DeadlineContext } from '@loremaster/database'

import type { Clock, DeadlineControl } from './dependencies.js'
import { PublicHttpError } from './errors.js'

export function createDeadlineControl(options: {
  readonly clock: Clock
  readonly timeoutMs: number
}): DeadlineControl {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive safe integer')
  }

  const contexts = new WeakMap<Request, DeadlineContext>()
  return {
    contextFor(request) {
      const context = contexts.get(request)
      if (context === undefined) throw new PublicHttpError('INTERNAL_ERROR')
      return context
    },
    middleware(request, response, next) {
      const controller = new AbortController()
      const deadlineAt = options.clock.now() + options.timeoutMs
      contexts.set(request, {
        deadlineAt,
        signal: controller.signal,
        now: () => options.clock.now(),
      })

      const timer = setTimeout(
        () => controller.abort('DEADLINE'),
        options.timeoutMs,
      )
      timer.unref()
      const clear = () => clearTimeout(timer)
      request.once('aborted', () => controller.abort('CLIENT_DISCONNECT'))
      response.once('finish', clear)
      response.once('close', () => {
        clear()
        if (!response.writableEnded) controller.abort('CLIENT_DISCONNECT')
      })
      next()
    },
  }
}
