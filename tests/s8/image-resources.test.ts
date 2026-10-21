import { describe, expect, it, vi } from 'vitest'

import {
  removeTrackedContainer,
  startTrackedContainer,
} from '../../scripts/s8-image-resources.mjs'

describe('S8 image test container cleanup', () => {
  it('removes a created container when docker run fails to start it', () => {
    const containers: string[] = []
    const existing = new Set<string>()
    const name = 'loremaster-s8-test-web'
    const docker = vi.fn((args: string[]) => {
      existing.add(args[3])
      throw Error('published port is already allocated')
    })
    const check = vi.fn((args: string[]) => {
      if (args[0] === 'rm' && existing.delete(args[2]))
        return { status: 0, stdout: args[2] }
      return { status: 1, stdout: '' }
    })

    expect(() =>
      startTrackedContainer(containers, name, ['test-image'], docker),
    ).toThrow('published port is already allocated')
    expect(existing.has(name)).toBe(true)
    for (const container of containers.reverse())
      expect(removeTrackedContainer(container, check)).toBe(true)
    expect(existing.size).toBe(0)
  })

  it('accepts a failed launch that never created its container', () => {
    const containers: string[] = []
    const docker = () => {
      throw Error('image not found')
    }
    const check = vi.fn((args: string[]) => ({
      status: args[0] === 'rm' ? 1 : 0,
      stdout: '',
    }))
    expect(() =>
      startTrackedContainer(containers, 'missing-image', [], docker),
    ).toThrow('image not found')
    expect(removeTrackedContainer(containers[0], check)).toBe(true)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('fails cleanup if removal fails and the exact container remains', () => {
    const check = (args: string[]) => ({
      status: args[0] === 'rm' ? 1 : 0,
      stdout: args[0] === 'rm' ? '' : 'loremaster-s8-test-web\n',
    })
    expect(removeTrackedContainer('loremaster-s8-test-web', check)).toBe(false)
  })

  it('fails cleanup when the daemon cannot confirm container absence', () => {
    expect(
      removeTrackedContainer('loremaster-s8-test-web', () => ({
        status: 1,
        stdout: '',
      })),
    ).toBe(false)
  })
})
