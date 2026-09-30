import { Worker, UnrecoverableError, type Job } from 'bullmq'
import { Redis } from 'ioredis'
import { guardQueueClient } from './script-guard.js'
import {
  WARM_JOB_NAME,
  WARM_POLICY,
  WARM_QUEUE_NAME,
  WARM_QUEUE_PREFIX,
  parseWarmPayload,
  warmJobId,
  type WarmResult,
} from './index.js'

export interface WarmWorkerPorts {
  readIndex(revisionId: string, signal: AbortSignal): Promise<unknown>
  writeIndex(index: unknown, signal: AbortSignal): Promise<void>
  onEvent?(code: 'warmed' | 'poison' | 'transient' | 'draining'): void
}
export interface WarmWorkerRuntime {
  start(): Promise<void>
  stop(): Promise<void>
}

export async function processWarmJob(
  job: Pick<Job, 'id' | 'name' | 'timestamp' | 'data'>,
  ports: WarmWorkerPorts,
  active: Set<AbortController> = new Set(),
): Promise<WarmResult> {
  let payload
  try {
    if (
      job.name !== WARM_JOB_NAME ||
      !Number.isSafeInteger(job.timestamp) ||
      job.timestamp > Date.now() + 60_000 ||
      Date.now() - job.timestamp > WARM_POLICY.maximumAgeMs
    )
      throw new Error('stale or unknown job')
    payload = parseWarmPayload(job.data)
    if (job.id !== warmJobId(payload.revisionId))
      throw new Error('Job identity mismatch')
  } catch {
    ports.onEvent?.('poison')
    throw new UnrecoverableError('Invalid warm job')
  }
  const controller = new AbortController()
  active.add(controller)
  const deadline = setTimeout(() => controller.abort(), WARM_POLICY.runtimeMs)
  deadline.unref()
  try {
    const index = await ports.readIndex(payload.revisionId, controller.signal)
    if (index === undefined)
      throw new UnrecoverableError('Published revision unavailable')
    if (controller.signal.aborted) throw new Error('Warm job timed out')
    await ports.writeIndex(index, controller.signal)
    if (controller.signal.aborted) throw new Error('Warm job timed out')
    ports.onEvent?.('warmed')
    return { version: 1, status: 'warmed' }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'INVALID_SUGGESTION_INDEX'
    ) {
      ports.onEvent?.('poison')
      throw new UnrecoverableError('Invalid published suggestion index')
    }
    if (error instanceof UnrecoverableError) ports.onEvent?.('poison')
    else ports.onEvent?.('transient')
    throw error
  } finally {
    clearTimeout(deadline)
    active.delete(controller)
  }
}

export function createWarmWorker(
  url: string,
  concurrency: number,
  ports: WarmWorkerPorts,
): WarmWorkerRuntime {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > WARM_POLICY.maximumConcurrency
  )
    throw new RangeError('Invalid worker concurrency')
  let redis: Redis | undefined
  let worker: Worker | undefined
  let stopped = false
  let stopping: Promise<void> | undefined
  const active = new Set<AbortController>()
  const processJob = (job: Job) => processWarmJob(job, ports, active)
  return {
    async start() {
      if (stopped || worker)
        throw new Error('Worker already started or stopped')
      redis = guardQueueClient(
        new Redis(url, {
          lazyConnect: true,
          enableOfflineQueue: false,
          autoResendUnfulfilledCommands: false,
          maxRetriesPerRequest: null,
          connectTimeout: 500,
          retryStrategy: (attempt) => {
            const base = Math.min(2000, 100 * 2 ** Math.min(attempt, 5))
            return Math.round(base * (0.8 + Math.random() * 0.4))
          },
        }),
        'worker',
      )
      worker = new Worker(WARM_QUEUE_NAME, processJob, {
        prefix: WARM_QUEUE_PREFIX,
        connection: redis,
        concurrency,
        autorun: false,
        maxStalledCount: WARM_POLICY.maximumStalledCount,
        lockDuration: 10_000,
      })
      let startupTimer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          worker.waitUntilReady(),
          new Promise<never>((_resolve, reject) => {
            startupTimer = setTimeout(
              () => reject(new Error('Worker Redis startup deadline')),
              WARM_POLICY.runtimeMs,
            )
            startupTimer.unref()
          }),
        ])
      } catch {
        redis.disconnect(false)
        void worker.close(true).catch(() => undefined)
        worker = undefined
        throw new Error('Worker Redis unavailable')
      } finally {
        if (startupTimer) clearTimeout(startupTimer)
      }
      void worker.run().catch(() => {
        ports.onEvent?.('transient')
      })
    },
    stop() {
      stopping ??= (async () => {
        stopped = true
        ports.onEvent?.('draining')
        if (!worker) return
        let timer: NodeJS.Timeout | undefined
        let drained = false
        const drain = worker.close(false).catch(() => undefined)
        await Promise.race([
          drain.then(() => {
            drained = true
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, WARM_POLICY.drainMs)
            timer.unref()
          }),
        ])
        if (timer) clearTimeout(timer)
        for (const controller of active) controller.abort()
        redis?.disconnect(false)
        if (!drained) {
          // BullMQ reuses the first close() promise; close(true) cannot interrupt it.
          const blocking = worker as unknown as {
            blockingConnection: { disconnect(wait: boolean): Promise<void> }
          }
          void blocking.blockingConnection
            .disconnect(false)
            .catch(() => undefined)
        }
      })()
      return stopping
    },
  }
}
