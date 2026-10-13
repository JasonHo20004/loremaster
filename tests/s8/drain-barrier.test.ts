import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import {
  drainWatcherScript,
  waitForBlockedRead,
} from '../../scripts/s8-drain-barrier.mjs'

function barrier() {
  let time = 0
  const events: string[] = []
  const signal = vi.fn(() => events.push('signal'))
  return {
    events,
    signal,
    options: {
      armed: () => events.push('armed'),
      signal,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms
      },
      timeoutMs: 100,
    },
  }
}

describe('S8 active-read drain barrier', () => {
  it('generates valid Node module code for the in-container watcher', () => {
    const result = spawnSync(
      process.execPath,
      ['--check', '--input-type=module'],
      {
        input: drainWatcherScript(),
        encoding: 'utf8',
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })
  it('arms before observation and signals exactly once only after a blocked read', async () => {
    const fixture = barrier()
    const blocked = vi.fn(async () => {
      fixture.events.push('observe')
      return fixture.events.filter((event) => event === 'observe').length === 3
    })
    await expect(
      waitForBlockedRead({ ...fixture.options, blocked }),
    ).resolves.toBe(50)
    expect(fixture.events).toEqual([
      'armed',
      'observe',
      'observe',
      'observe',
      'signal',
    ])
    expect(fixture.signal).toHaveBeenCalledTimes(1)
  })

  it('does not signal if no blocked read appears before the deadline', async () => {
    const fixture = barrier()
    await expect(
      waitForBlockedRead({ ...fixture.options, blocked: async () => false }),
    ).rejects.toThrow('Blocked read barrier timed out')
    expect(fixture.signal).not.toHaveBeenCalled()
  })

  it('does not signal after an observation error', async () => {
    const fixture = barrier()
    await expect(
      waitForBlockedRead({
        ...fixture.options,
        blocked: async () => {
          throw Error('query failed')
        },
      }),
    ).rejects.toThrow('query failed')
    expect(fixture.signal).not.toHaveBeenCalled()
  })

  it('does not signal when an observation finishes after the deadline', async () => {
    const fixture = barrier()
    await expect(
      waitForBlockedRead({
        ...fixture.options,
        blocked: async () => {
          await fixture.options.sleep(100)
          return true
        },
      }),
    ).rejects.toThrow('Blocked read barrier timed out')
    expect(fixture.signal).not.toHaveBeenCalled()
  })
})
