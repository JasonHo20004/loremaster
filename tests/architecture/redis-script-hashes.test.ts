import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  CACHE_SET_V1_SHA256,
  LIMITER_V1_SHA256,
} from '../../packages/cache/src/index.js'
import { PRODUCER_ADMISSION_V1_SHA256 } from '../../packages/queue/src/index.js'

it('pins the three non-BullMQ Redis operations to the reviewed hashes', () => {
  const ledger = JSON.parse(
    readFileSync(
      new URL('../../ops/redis/runtime-script-hashes.json', import.meta.url),
      'utf8',
    ),
  )
  expect({
    cacheSet: CACHE_SET_V1_SHA256,
    producerAdmission: PRODUCER_ADMISSION_V1_SHA256,
    limiter: LIMITER_V1_SHA256,
  }).toEqual(ledger)
})
