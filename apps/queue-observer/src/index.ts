import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BoundedRedisConnection } from '@loremaster/cache'
import { parseObserverConfiguration } from '@loremaster/config'
import {
  createPrivateHealthServer,
  renderQueueMetrics,
  type QueueSnapshot,
} from '@loremaster/observability'
import { WARM_QUEUE_NAME, WARM_QUEUE_PREFIX } from '@loremaster/queue'

const prefix = `${WARM_QUEUE_PREFIX}:${WARM_QUEUE_NAME}`

/** Only aggregate reads; neither BullMQ Job objects nor hash/payload reads. */
export function createQueueObservation(connection: BoundedRedisConnection) {
  let pending: Promise<QueueSnapshot> | undefined
  let last: { at: number; value: QueueSnapshot } | undefined
  let valid = false
  const unavailable: QueueSnapshot = {
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
    oldestRetainedAgeSeconds: 0,
    workerConnected: 0,
    degraded: 1,
  }
  const inspect = (signal: AbortSignal): Promise<QueueSnapshot> => {
    if (last && Date.now() - last.at < 1000) return Promise.resolve(last.value)
    pending ??= connection
      .run(async (client) => {
        const [
          waiting,
          active,
          delayed,
          completed,
          failed,
          oldestCompleted,
          oldestFailed,
          heartbeat,
        ] = await Promise.all([
          client.llen(`${prefix}:wait`),
          client.llen(`${prefix}:active`),
          client.zcard(`${prefix}:delayed`),
          client.zcard(`${prefix}:completed`),
          client.zcard(`${prefix}:failed`),
          client.zrange(`${prefix}:completed`, 0, 0, 'WITHSCORES'),
          client.zrange(`${prefix}:failed`, 0, 0, 'WITHSCORES'),
          client.get(`${prefix}:health`),
        ])
        let oldestRetainedAgeSeconds = 0
        for (const pair of [oldestCompleted, oldestFailed]) {
          if (!Array.isArray(pair) || (pair.length !== 0 && pair.length !== 2))
            throw new Error('Invalid queue age')
          if (pair.length === 2) {
            const timestamp = Number(pair[1])
            if (
              !Number.isSafeInteger(timestamp) ||
              timestamp < 0 ||
              timestamp > Date.now() + 60000
            )
              throw new Error('Invalid queue age')
            oldestRetainedAgeSeconds = Math.max(
              oldestRetainedAgeSeconds,
              Math.min(
                172800,
                Math.max(0, Math.floor((Date.now() - timestamp) / 1000)),
              ),
            )
          }
        }
        if (heartbeat !== null && heartbeat !== '1')
          throw new Error('Invalid worker health')
        const value: QueueSnapshot = {
          waiting,
          active,
          delayed,
          completed,
          failed,
          oldestRetainedAgeSeconds,
          workerConnected: heartbeat === '1' ? 1 : 0,
          degraded: heartbeat === '1' ? 0 : 1,
        }
        if (waiting + active + delayed > 128)
          throw new Error('Invalid queue capacity')
        renderQueueMetrics(value)
        valid = true
        return value
      }, signal)
      .catch(() => {
        valid = false
        return { ...unavailable }
      })
      .then((value) => {
        last = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
  return { inspect, ready: () => valid }
}

export function createObserverRuntime(options: {
  redisUrl: string
  port?: number
}) {
  const connection = new BoundedRedisConnection(options.redisUrl, 'observer')
  const observation = createQueueObservation(connection)
  const health = createPrivateHealthServer({
    port: options.port ?? 3002,
    async ready(signal) {
      await connection.run((client) => client.ping(), signal)
      await observation.inspect(signal)
      return observation.ready()
    },
    async metrics(signal) {
      return renderQueueMetrics(await observation.inspect(signal))
    },
  })
  return {
    server: health.server,
    start: health.start,
    drain: health.drain,
    async stop() {
      health.drain()
      connection.close()
      await health.stop()
    },
  }
}

export async function runObserver(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseObserverConfiguration(env)
  const runtime = createObserverRuntime({
    redisUrl: config.redisUrl,
    port: config.healthPort,
  })
  const shutdown = () => {
    void runtime.stop().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  try {
    await runtime.start()
  } catch {
    await runtime.stop()
    throw new Error('Observer startup failed')
  }
}
const invokedPath = process.argv[1]
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  void runObserver().catch(() => {
    process.stderr.write('Loremaster observer failed\n')
    process.exitCode = 1
  })
}
