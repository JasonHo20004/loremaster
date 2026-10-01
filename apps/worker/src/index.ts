import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  BoundedRedisConnection,
  createSuggestionCacheWriter,
  parseSuggestionIndex,
  serializeSuggestionIndex,
  type SuggestionIndex,
} from '@loremaster/cache'
import { parseWorkerConfiguration } from '@loremaster/config'
import {
  closeDatabase,
  database,
  readPublishedSuggestionIndex,
  assertOutsideTransaction,
  type DeadlineContext,
  transaction,
} from '@loremaster/database'
import { createWarmWorker } from '@loremaster/queue'
import { createPrivateHealthServer } from '@loremaster/observability'

export async function runWorker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseWorkerConfiguration(env)
  const db = database(config.databaseUrl, { connectionTimeoutMs: 1000 })
  const cache = new BoundedRedisConnection(config.cacheRedisUrl, 'worker')
  const writer = createSuggestionCacheWriter(cache, {
    assertOutsideTransaction,
  })
  const worker = createWarmWorker(config.redisUrl, config.concurrency, {
    async readIndex(revisionId, signal) {
      const deadline: DeadlineContext = {
        deadlineAt: Date.now() + 5_000,
        now: () => Date.now(),
        signal,
      }
      const index = await readPublishedSuggestionIndex(
        db,
        revisionId,
        deadline,
        'loremaster_cache_worker',
      )
      return index === undefined
        ? undefined
        : parseSuggestionIndex(serializeSuggestionIndex(index))
    },
    async writeIndex(index, signal) {
      // The writer performs the same strict validation again at its boundary.
      await writer.set(index as SuggestionIndex, signal)
    },
    onEvent: (() => {
      const last = new Map<string, number>()
      return (code) => {
        if (code === 'warmed') return
        const now = Date.now()
        if (now - (last.get(code) ?? 0) < 60_000) return
        last.set(code, now)
        process.stderr.write(`Loremaster worker: ${code}\n`)
      }
    })(),
  })
  const health = createPrivateHealthServer({
    port: config.healthPort,
    async ready(signal) {
      if (!worker.ready()) return false
      await Promise.all([
        cache.run((client) => client.ping(), signal),
        transaction(
          db,
          async (client) => {
            await client.query('SELECT 1')
          },
          {
            role: 'loremaster_cache_worker',
            readOnly: true,
            deadline: {
              deadlineAt: Date.now() + 1000,
              now: () => Date.now(),
              signal,
            },
          },
        ),
      ])
      return worker.ready()
    },
  })
  let closing: Promise<void> | undefined
  const stop = () => {
    closing ??= (async () => {
      health.drain()
      try {
        await worker.stop()
      } finally {
        cache.close()
        await health.stop()
        await closeDatabase(db)
      }
    })()
    return closing
  }
  const shutdown = () => {
    void stop().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  try {
    await health.start()
    await worker.start()
  } catch (error) {
    await stop()
    throw error
  }
}

const invokedPath = process.argv[1]
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  void runWorker().catch(() => {
    process.stderr.write('Loremaster cache worker failed\n')
    process.exitCode = 1
  })
}
