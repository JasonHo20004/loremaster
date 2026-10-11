import { describe, expect, it } from 'vitest'
import {
  parseServerEnvironment,
  parseObserverConfiguration,
  parseWorkerConfiguration,
} from '../../packages/config/src/index.js'

const api = {
  LOREMASTER_API_MODE: 'local',
  DATABASE_URL: 'postgresql://runtime:pass@db/test',
  LOREMASTER_API_ORIGIN: 'http://localhost:8080',
  LOREMASTER_API_CURSOR_ACTIVE_VERSION: 's8',
  LOREMASTER_API_CURSOR_ACTIVE_KEY: Buffer.alloc(32, 1).toString('base64url'),
}
const worker = {
  LOREMASTER_WORKER_REDIS_URL: 'redis://loremaster_worker:pass@redis',
  LOREMASTER_WORKER_CACHE_REDIS_URL:
    'redis://loremaster_worker_cache:pass@redis',
  LOREMASTER_WORKER_DATABASE_URL: 'postgresql://worker:pass@db/test',
}
const observer = {
  LOREMASTER_OBSERVER_REDIS_URL: 'redis://loremaster_observer:pass@redis',
}
describe('container listen hosts', () => {
  it('keeps host defaults loopback and allows the explicit container interface', () => {
    expect(parseServerEnvironment(api).listenHost).toBe('127.0.0.1')
    expect(
      parseServerEnvironment({ ...api, LOREMASTER_API_LISTEN_HOST: '0.0.0.0' })
        .listenHost,
    ).toBe('0.0.0.0')
    expect(
      parseWorkerConfiguration({
        ...worker,
        LOREMASTER_WORKER_LISTEN_HOST: '0.0.0.0',
      }).healthHost,
    ).toBe('0.0.0.0')
    expect(
      parseObserverConfiguration({
        ...observer,
        LOREMASTER_OBSERVER_LISTEN_HOST: '0.0.0.0',
      }).healthHost,
    ).toBe('0.0.0.0')
  })
  it.each(['', 'localhost', '::', '0.0.0.0 ', 'http://0.0.0.0', '1.2.3.4'])(
    'rejects ambiguous or unsupported host %s',
    (host) => {
      expect(() =>
        parseServerEnvironment({ ...api, LOREMASTER_API_LISTEN_HOST: host }),
      ).toThrow()
      expect(() =>
        parseWorkerConfiguration({
          ...worker,
          LOREMASTER_WORKER_LISTEN_HOST: host,
        }),
      ).toThrow()
      expect(() =>
        parseObserverConfiguration({
          ...observer,
          LOREMASTER_OBSERVER_LISTEN_HOST: host,
        }),
      ).toThrow()
    },
  )
})
