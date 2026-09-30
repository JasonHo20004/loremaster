import { describe, expect, it } from 'vitest'
import { guardQueueClient } from '../../packages/queue/src/script-guard.js'
import {
  processWarmJob,
  warmJobId,
  WARM_JOB_NAME,
} from '../../packages/queue/src/index.js'

const revisionId = '12345678-1234-1234-1234-123456789abc'
const job = {
  id: warmJobId(revisionId),
  name: WARM_JOB_NAME,
  data: { version: 1, revisionId },
  timestamp: Date.now(),
}

describe('warm job runtime boundaries', () => {
  it('rejects poison before any database read', async () => {
    let reads = 0
    const ports = {
      readIndex: async () => {
        reads++
        return {}
      },
      writeIndex: async () => undefined,
    }
    await expect(
      processWarmJob(
        { ...job, data: { ...job.data, guestId: 'private' } },
        ports,
      ),
    ).rejects.toThrow('Invalid warm job')
    await expect(
      processWarmJob({ ...job, id: 'wrong' }, ports),
    ).rejects.toThrow('Invalid warm job')
    await expect(
      processWarmJob({ ...job, timestamp: Date.now() - 172_800_001 }, ports),
    ).rejects.toThrow('Invalid warm job')
    expect(reads).toBe(0)
  })

  it('replays the same immutable revision without a domain effect', async () => {
    const writes: unknown[] = []
    const index = { version: 1, revisionId, entities: [] }
    const ports = {
      readIndex: async () => index,
      writeIndex: async (value: unknown) => {
        writes.push(value)
      },
    }
    expect(await processWarmJob(job, ports)).toEqual({
      version: 1,
      status: 'warmed',
    })
    expect(await processWarmJob(job, ports)).toEqual({
      version: 1,
      status: 'warmed',
    })
    expect(writes).toEqual([index, index])
  })

  it('does not retry a published revision that has disappeared', async () => {
    await expect(
      processWarmJob(job, {
        readIndex: async () => undefined,
        writeIndex: async () => undefined,
      }),
    ).rejects.toThrow('Published revision unavailable')
  })

  it('propagates drain cancellation to an active database read', async () => {
    const active = new Set<AbortController>()
    let wrote = false
    const run = processWarmJob(
      job,
      {
        readIndex: async (_revisionId, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('database cancelled')),
              { once: true },
            )
          }),
        writeIndex: async () => {
          wrote = true
        },
      },
      active,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(active.size).toBe(1)
    active.values().next().value!.abort()
    await expect(run).rejects.toThrow('database cancelled')
    expect(active.size).toBe(0)
    expect(wrote).toBe(false)
  })
})

it('denies an unreviewed BullMQ script before any Redis command', () => {
  const fake = {
    defineCommand(name: string) {
      ;(this as unknown as Record<string, unknown>)[name] = () =>
        'should not run'
    },
    duplicate() {
      return this
    },
  }
  const client = guardQueueClient(
    fake as unknown as Parameters<typeof guardQueueClient>[0],
    'producer',
  )
  client.defineCommand('arbitrary:5.81.5', {
    numberOfKeys: 1,
    lua: "return redis.call('GET',KEYS[1])",
  })
  const command = (
    client as unknown as Record<string, (args: string[]) => Promise<unknown>>
  )['arbitrary:5.81.5']
  expect(command).toBeDefined()
  expect(() =>
    command!(['loremaster:v1:queue:loremaster-warm-v1:wait']),
  ).toThrow('Unreviewed queue script')
})
