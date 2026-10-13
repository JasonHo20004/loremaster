import { describe, expect, it } from 'vitest'
import {
  parseWarmPayload,
  warmJobId,
  parseWarmResult,
  WARM_POLICY,
} from '../../packages/queue/src/index.js'

const revisionId = '12345678-1234-4234-8234-123456789abc'
describe('warm contract', () => {
  it('has deterministic BullMQ-safe IDs and bounded policy', () => {
    expect(warmJobId(revisionId)).toBe(`warm-v1-${revisionId}`)
    expect(WARM_POLICY.attempts).toBe(3)
    expect(WARM_POLICY.runtimeMs).toBe(5000)
  })
  it.each([
    null,
    '',
    {},
    { version: 2, revisionId },
    { version: 1, revisionId, guest: 'secret' },
    { version: 1, revisionId: '../x' },
    { version: 1, revisionId: 'a'.repeat(10000) },
  ])('rejects poison %j', (value) => {
    expect(() => parseWarmPayload(value)).toThrow('Invalid warm payload')
  })
  it('validates payload and result without arbitrary fields', () => {
    expect(parseWarmPayload({ version: 1, revisionId })).toEqual({
      version: 1,
      revisionId,
    })
    expect(parseWarmResult({ version: 1, status: 'warmed' })).toEqual({
      version: 1,
      status: 'warmed',
    })
    expect(() =>
      parseWarmResult({ version: 1, status: 'warmed', secret: true }),
    ).toThrow()
  })
  it('freezes nested policy and parsed values', () => {
    expect(Object.isFrozen(WARM_POLICY)).toBe(true)
    expect(Object.isFrozen(WARM_POLICY.backoff)).toBe(true)
    expect(Object.isFrozen(WARM_POLICY.removeOnComplete)).toBe(true)
    expect(Object.isFrozen(WARM_POLICY.removeOnFail)).toBe(true)
    expect(Object.isFrozen(parseWarmPayload({ version: 1, revisionId }))).toBe(
      true,
    )
    expect(
      Object.isFrozen(parseWarmResult({ version: 1, status: 'warmed' })),
    ).toBe(true)
    expect(WARM_POLICY.maximumConcurrency).toBe(4)
  })
  it('rejects accessor, private and oversized data without executing serializers', () => {
    const payload = {
      version: 1,
      get revisionId() {
        throw new Error('private')
      },
    }
    expect(() => parseWarmPayload(payload)).toThrow('Invalid warm payload')
    expect(() =>
      parseWarmPayload({
        version: 1,
        revisionId,
        toJSON() {
          throw new Error('private')
        },
      }),
    ).toThrow('Invalid warm payload')
    expect(() =>
      parseWarmPayload({ version: 1, revisionId: '😀'.repeat(10000) }),
    ).toThrow('Invalid warm payload')
    expect(() =>
      parseWarmPayload({ version: 1, revisionId: revisionId.toUpperCase() }),
    ).toThrow('Invalid warm payload')
    expect(() =>
      parseWarmPayload({ version: 1, revisionId, [Symbol('secret')]: true }),
    ).toThrow('Invalid warm payload')
    expect(
      Buffer.byteLength(
        JSON.stringify(parseWarmPayload({ version: 1, revisionId })),
      ),
    ).toBeLessThanOrEqual(WARM_POLICY.payloadMaxBytes)
    expect(
      Buffer.byteLength(
        JSON.stringify(parseWarmResult({ version: 1, status: 'warmed' })),
      ),
    ).toBeLessThanOrEqual(WARM_POLICY.resultMaxBytes)
  })
  it.each([
    null,
    [],
    { version: 2, status: 'warmed' },
    { version: 1, status: 'secret' },
    { version: 1, status: 'warmed', revisionId },
    { version: 1, status: 'warmed', cookie: 'private' },
  ])('rejects malformed result', (value) => {
    expect(() => parseWarmResult(value)).toThrow('Invalid warm result')
  })
})
