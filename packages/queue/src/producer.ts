import { createHash } from 'node:crypto'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { guardQueueClient } from './script-guard.js'
import {
  WARM_JOB_NAME,
  WARM_POLICY,
  WARM_QUEUE_NAME,
  WARM_QUEUE_PREFIX,
  warmJobId,
} from './index.js'

export interface WarmProducerPorts {
  currentRevision(signal: AbortSignal): Promise<string | undefined>
  onEvent?(code: 'scheduled' | 'duplicate' | 'capacity' | 'unavailable'): void
}
export interface WarmProducer {
  start(): void
  reconcile(): Promise<void>
  stop(): Promise<void>
}

/** Redis-time reservation covers concurrent producers until their one-second enqueue deadline. */
export const PRODUCER_ADMISSION_V1_LUA = `#!lua
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', nowMs)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 2 end
local count = redis.call('ZCARD', KEYS[1]) + redis.call('LLEN', KEYS[2]) + redis.call('LLEN', KEYS[3]) + redis.call('ZCARD', KEYS[4]) + redis.call('ZCARD', KEYS[5])
if count >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], nowMs + 2000, ARGV[1])
redis.call('PEXPIRE', KEYS[1], 3000)
return 1
`.trim()

export const PRODUCER_ADMISSION_V1_SHA256 = createHash('sha256')
  .update(PRODUCER_ADMISSION_V1_LUA)
  .digest('hex')

/** Reconstructible reconciliation; no request or gameplay transaction calls this port. */
export function createWarmProducer(
  url: string,
  ports: WarmProducerPorts,
): WarmProducer {
  let redis: Redis | undefined
  let queue: Queue | undefined
  let timer: NodeJS.Timeout | undefined
  let recoveryTimer: NodeJS.Timeout | undefined
  let recoveryAttempt = 0
  let pending: Promise<void> | undefined
  let stopped = false
  const scheduleRecovery = () => {
    if (stopped || recoveryTimer) return
    const base = Math.min(2_000, 100 * 2 ** Math.min(recoveryAttempt++, 5))
    recoveryTimer = setTimeout(
      () => {
        recoveryTimer = undefined
        void reconcile()
      },
      Math.round(base * (0.8 + Math.random() * 0.4)),
    )
    recoveryTimer.unref()
  }
  const connect = (): Queue => {
    if (queue) return queue
    redis = guardQueueClient(
      new Redis(url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0,
        connectTimeout: 500,
        retryStrategy: (attempt) => {
          const base = Math.min(2_000, 100 * 2 ** Math.min(attempt, 5))
          return Math.round(base * (0.8 + Math.random() * 0.4))
        },
      }),
      'producer',
    )
    redis.on('ready', () => {
      recoveryAttempt = 0
      if (!stopped) void reconcile()
    })
    redis.on('end', scheduleRecovery)
    redis.on('error', () => ports.onEvent?.('unavailable'))
    queue = new Queue(WARM_QUEUE_NAME, {
      prefix: WARM_QUEUE_PREFIX,
      connection: redis,
      // BullMQ's MAXLEN is approximate; retain headroom under the 1,024-event cap.
      streams: {
        events: { maxLen: Math.floor(WARM_POLICY.maximumEvents / 2) },
      },
      defaultJobOptions: {
        attempts: WARM_POLICY.attempts,
        backoff: WARM_POLICY.backoff,
        removeOnComplete: WARM_POLICY.removeOnComplete,
        removeOnFail: WARM_POLICY.removeOnFail,
        stackTraceLimit: WARM_POLICY.stackTraceLimit,
      },
    })
    queue.on('error', () => ports.onEvent?.('unavailable'))
    return queue
  }
  const run = async (): Promise<void> => {
    const controller = new AbortController()
    let deadline: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        controller.abort()
        redis?.disconnect(false)
        queue = undefined
        redis = undefined
        reject(new Error('Producer deadline'))
      }, WARM_POLICY.producerDeadlineMs)
      deadline.unref()
    })
    try {
      await Promise.race([
        (async () => {
          const revisionId = await ports.currentRevision(controller.signal)
          if (!revisionId || stopped || controller.signal.aborted) return
          const id = warmJobId(revisionId)
          const client = connect()
          const existing = await client.getJob(id)
          if (existing) {
            const state = await existing.getState()
            if (state === 'completed' || state === 'failed')
              await existing.remove()
            else {
              ports.onEvent?.('duplicate')
              return
            }
          }
          const prefix = `${WARM_QUEUE_PREFIX}:${WARM_QUEUE_NAME}`
          const admitted = await redis!.eval(
            PRODUCER_ADMISSION_V1_LUA,
            5,
            `${prefix}:admission`,
            `${prefix}:wait`,
            `${prefix}:active`,
            `${prefix}:delayed`,
            `${prefix}:prioritized`,
            id,
            String(WARM_POLICY.maximumOutstandingJobs),
          )
          if (admitted === 0) {
            ports.onEvent?.('capacity')
            return
          }
          if (admitted === 2) {
            ports.onEvent?.('duplicate')
            return
          }
          if (admitted !== 1) throw new Error('Invalid admission result')
          if (controller.signal.aborted) return
          await client.add(
            WARM_JOB_NAME,
            { version: 1, revisionId },
            { jobId: id },
          )
          await redis!.zrem(`${prefix}:admission`, id)
          ports.onEvent?.('scheduled')
        })(),
        timeout,
      ])
      recoveryAttempt = 0
    } catch {
      ports.onEvent?.('unavailable')
      redis?.disconnect(false)
      queue = undefined
      redis = undefined
      scheduleRecovery()
    } finally {
      if (deadline) clearTimeout(deadline)
    }
  }
  const reconcile = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    pending ??= run().finally(() => {
      pending = undefined
    })
    return pending
  }
  return {
    start() {
      if (stopped || timer) return
      void reconcile()
      timer = setInterval(() => {
        void reconcile()
      }, WARM_POLICY.reconcileIntervalMs)
      timer.unref()
    },
    reconcile,
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      if (recoveryTimer) clearTimeout(recoveryTimer)
      await pending
      redis?.disconnect(false)
      await Promise.race([
        queue?.close().catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((resolve) => {
          const closeTimer = setTimeout(resolve, 1_000)
          closeTimer.unref()
        }),
      ])
    },
  }
}
