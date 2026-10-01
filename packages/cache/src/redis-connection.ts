import { Redis } from 'ioredis'
import { REDIS_CLIENT_PROFILES, type RedisClientProfile } from './profiles.js'

export class RedisOperationError extends Error {
  constructor(
    readonly reason:
      'timeout' | 'unavailable' | 'cancelled' | 'acl_denied' | 'capacity',
  ) {
    super(`Redis operation ${reason}`)
    this.name = 'RedisOperationError'
  }
}

export function redisFailure(error: unknown): RedisOperationError['reason'] {
  if (error instanceof RedisOperationError) return error.reason
  const message = error instanceof Error ? error.message : ''
  if (/NOPERM|NOAUTH|WRONGPASS/u.test(message)) return 'acl_denied'
  if (/OOM|noeviction/u.test(message)) return 'capacity'
  return 'unavailable'
}

/** Owns one lazy connection. A timed-out command destroys it before a retry can occur. */
export class BoundedRedisConnection {
  private client: Redis | undefined
  private connecting: Promise<void> | undefined
  private closed = false
  constructor(
    private readonly url: string,
    private readonly profile: RedisClientProfile,
  ) {}

  async run<T>(
    work: (client: Redis) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) throw new RedisOperationError('unavailable')
    if (signal?.aborted) throw new RedisOperationError('cancelled')
    const policy = REDIS_CLIENT_PROFILES[this.profile]
    const client =
      this.client ??
      new Redis(this.url, {
        lazyConnect: true,
        enableReadyCheck: false,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: policy.maxRetriesPerRequest,
        connectTimeout: policy.connectTimeoutMs,
        retryStrategy: (attempt) => {
          const base = Math.min(
            policy.reconnectMaximumMs,
            policy.reconnectMinimumMs * 2 ** Math.min(attempt, 5),
          )
          return Math.round(
            base *
              (1 -
                policy.reconnectJitterRatio +
                Math.random() * policy.reconnectJitterRatio * 2),
          )
        },
      })
    this.client = client
    // Dependency errors are classified by the caller; never print raw driver text.
    if (client.listenerCount('error') === 0) client.on('error', () => undefined)
    const bounded = async <Value>(
      operation: Promise<Value>,
      milliseconds: number,
    ): Promise<Value> => {
      let timer: NodeJS.Timeout | undefined
      let abort: (() => void) | undefined
      const cancellation = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RedisOperationError('timeout')),
          milliseconds,
        )
        timer.unref()
        abort = () => reject(new RedisOperationError('cancelled'))
        signal?.addEventListener('abort', abort, { once: true })
      })
      try {
        return await Promise.race([operation, cancellation])
      } finally {
        if (timer) clearTimeout(timer)
        if (abort) signal?.removeEventListener('abort', abort)
      }
    }
    try {
      if (client.status === 'wait' || client.status === 'connecting') {
        this.connecting ??= client.connect()
        await bounded(this.connecting, policy.connectTimeoutMs)
        this.connecting = undefined
      }
      if (signal?.aborted) throw new RedisOperationError('cancelled')
      return await bounded(work(client), policy.commandTimeoutMs)
    } catch (error) {
      // Destructive cancellation prevents a queued command from running on reconnect.
      client.disconnect(false)
      if (this.client === client) this.client = undefined
      this.connecting = undefined
      throw error
    }
  }

  close(): void {
    this.closed = true
    this.client?.disconnect(false)
    this.client = undefined
    this.connecting = undefined
  }
}
