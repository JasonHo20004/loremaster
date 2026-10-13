import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

async function source(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? source(join(directory, entry.name))
          : readFile(join(directory, entry.name), 'utf8'),
      ),
    )
  ).join('\n')
}

describe('server cache package boundaries', () => {
  it('keeps cache independent of applications, database, queue and browser contracts', async () => {
    const cache = await source('packages/cache/src')
    expect(cache).not.toMatch(
      /(?:from|import)\s*['"].*(?:@loremaster|apps\/|packages\/)/u,
    )
  })

  it('keeps browser contracts free of server package exports', async () => {
    const contracts = await source('packages/contracts/src')
    expect(contracts).not.toMatch(
      /(?:from|import)\s*['"].*(?:@loremaster\/(?:cache|queue|database)|packages\/(?:cache|queue|database))/u,
    )
  })

  it('declares one Redis client version shared with BullMQ', async () => {
    const queue = JSON.parse(
      await readFile('packages/queue/package.json', 'utf8'),
    )
    const cache = JSON.parse(
      await readFile('packages/cache/package.json', 'utf8'),
    )
    const lockfile = await readFile('pnpm-lock.yaml', 'utf8')
    expect(queue.dependencies.ioredis).toBe(cache.dependencies.ioredis)
    expect(queue.dependencies.bullmq).toBe('5.81.5')
    expect([
      ...new Set(
        [...lockfile.matchAll(/^ {2}ioredis@([^:]+):/gmu)].map(
          (match) => match[1],
        ),
      ),
    ]).toEqual(['5.11.1'])
  })
})
