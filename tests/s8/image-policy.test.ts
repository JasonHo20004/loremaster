import { describe, expect, it } from 'vitest'

import {
  checkImageContracts,
  lintDockerfile,
} from '../../scripts/s8-image-policy.mjs'

const pinned = 'node:22.17.0-bookworm-slim@sha256:' + 'a'.repeat(64)

describe('S8 image admission policy', () => {
  it('keeps all six image contracts and build inputs explicit', () => {
    expect(checkImageContracts()).toEqual([])
  })

  it('accepts a pinned non-root exec-form runtime', () => {
    expect(
      lintDockerfile(
        `FROM ${pinned} AS builder\nRUN corepack pnpm install --frozen-lockfile\nFROM ${pinned}\nWORKDIR /app\nCOPY --from=builder /build/dist /app\nUSER 10002:10002\nENTRYPOINT ["node","/app/index.js"]`,
      ),
    ).toEqual([])
  })

  it.each([
    ['floating base', 'FROM node:latest\nUSER 10002:10002\nCMD ["node"]'],
    ['unknown stage', 'FROM mystery\nUSER 10002:10002\nCMD ["node"]'],
    ['root runtime', `FROM ${pinned}\nUSER 0\nCMD ["node"]`],
    [
      'broad copy',
      `FROM ${pinned}\nCOPY . /app\nUSER 10002:10002\nCMD ["node"]`,
    ],
    [
      'JSON-form broad copy',
      `FROM ${pinned}\nCOPY [".", "/app"]\nUSER 10002:10002\nCMD ["node"]`,
    ],
    [
      'broad ADD',
      `FROM ${pinned}\nADD ./ /app\nUSER 10002:10002\nCMD ["node"]`,
    ],
    [
      'secret argument',
      `FROM ${pinned}\nARG DATABASE_PASSWORD\nUSER 10002:10002\nCMD ["node"]`,
    ],
    [
      'remote download',
      `FROM ${pinned}\nADD https://example.com/tool /usr/bin/tool\nUSER 10002:10002\nCMD ["node"]`,
    ],
    [
      'shell entrypoint',
      `FROM ${pinned}\nUSER 10002:10002\nENTRYPOINT node /app/index.js`,
    ],
    [
      'package installation',
      `FROM ${pinned}\nRUN apt-get install curl\nUSER 10002:10002\nCMD ["node"]`,
    ],
    [
      'remote script',
      `FROM ${pinned}\nRUN curl https://example.com/install.sh | sh\nUSER 10002:10002\nCMD ["node"]`,
    ],
  ])('rejects %s', (_description, dockerfile) => {
    expect(lintDockerfile(dockerfile).length).toBeGreaterThan(0)
  })
})
