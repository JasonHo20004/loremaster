import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { buildImage } from './s8-build.mjs'

const original = JSON.parse(
  readFileSync('.cache/s8-build-results.json', 'utf8'),
)
assert.equal(original.length, 6, 'All six images must be built first')
const repeated = original.map(({ profile }) => buildImage(profile))
for (let index = 0; index < original.length; index++)
  assert.deepEqual(
    repeated[index],
    original[index],
    `Non-reproducible image: ${original[index].profile}`,
  )
writeFileSync(
  '.cache/s8-reproducibility.json',
  JSON.stringify(
    {
      status: 'PASS',
      profiles: repeated.map(({ profile, id, contextSha256 }) => ({
        profile,
        id,
        contextSha256,
      })),
    },
    null,
    2,
  ) + '\n',
)
process.stdout.write('All six S8 image IDs and context digests reproduced\n')
