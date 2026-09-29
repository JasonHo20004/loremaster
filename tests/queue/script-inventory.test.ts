import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { collectScriptCommands } from '../../scripts/s7-bullmq-policy.mjs'

describe('reviewed BullMQ command inventory', () => {
  it('includes reviewed indirect queue push operations', () => {
    expect(
      collectScriptCommands(
        'rcall("SET", key, value); rcall(pushCmd, key, value)',
        ['lpush', 'rpush'],
        1,
      ),
    ).toEqual(['lpush', 'rpush', 'set'])
  })
  it('fails closed on unreviewed dynamic command expressions or counts', () => {
    expect(() =>
      collectScriptCommands('rcall(commandFromJob, key)', [], 0),
    ).toThrow()
    expect(() => collectScriptCommands('rcall(pushCmd, key)', [], 0)).toThrow()
    expect(() =>
      collectScriptCommands('rcall("SET", key, value)', ['lpush'], 1),
    ).toThrow()
    expect(() =>
      collectScriptCommands('redis.call("FLUSHALL")', [], 0),
    ).toThrow()
  })
  it('records normal FIFO/LIFO pushes and role-specific scripts', async () => {
    const inventory = JSON.parse(
      await readFile('ops/redis/bullmq-script-inventory.json', 'utf8'),
    )
    expect(inventory.scripts.addStandardJob.commands).toEqual(
      expect.arrayContaining(['lpush', 'rpush']),
    )
    expect(inventory.scripts.moveStalledJobsToWait.commands).toContain('rpush')
    expect(inventory.scripts.addStandardJob.roles).toEqual(['producer'])
    expect(
      Object.values(inventory.scripts).every(
        (script: unknown) =>
          typeof script === 'object' && script !== null && 'sha256' in script,
      ),
    ).toBe(true)
  })
})
