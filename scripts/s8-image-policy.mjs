import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { profiles, readAllowlist, repositoryRoot } from './s8-context.mjs'

const digest = /@sha256:[a-f0-9]{64}$/u
const secretName =
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|HMAC|PRIVATE_KEY|CREDENTIAL)/iu

export function lintDockerfile(source) {
  const errors = []
  const logicalLines = source
    .replace(/\\\r?\n\s*/gu, ' ')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const totalStages = logicalLines.filter((line) =>
    /^FROM\s/iu.test(line),
  ).length
  const aliases = new Set()
  let stageCount = 0
  let hasNumericUser = false
  let hasFrozenInstall = false
  let hasCorepack = false
  for (const line of logicalLines) {
    const [instruction = '', ...pieces] = line.split(/\s+/u)
    const upper = instruction.toUpperCase()
    const argument = pieces.join(' ')
    if (upper === 'FROM') {
      stageCount += 1
      hasNumericUser = false
      const base = pieces[0] ?? ''
      if (!digest.test(base) && !aliases.has(base)) {
        errors.push('FROM must use a digest-pinned image or an earlier stage')
      }
      if (/:latest(?:@|$)/iu.test(base)) errors.push('latest tag is forbidden')
      if (pieces[1]?.toUpperCase() === 'AS' && pieces[2]) {
        aliases.add(pieces[2])
      }
    }
    if ((upper === 'ARG' || upper === 'ENV') && secretName.test(argument)) {
      errors.push('secret-like ARG or ENV is forbidden')
    }
    if (
      (upper === 'COPY' || upper === 'ADD') &&
      (/^(?:--[^ ]+\s+)*(?:\.\/?|\/)\s/u.test(argument) ||
        /^(?:--[^ ]+\s+)*\[\s*"(?:\.\/?|\/)"\s*,/u.test(argument))
    ) {
      errors.push('repository-root COPY is forbidden')
    }
    if (upper === 'ADD' && /https?:\/\//iu.test(argument)) {
      errors.push('remote ADD is forbidden')
    }
    if (upper === 'USER') {
      hasNumericUser = /^[1-9][0-9]*:[1-9][0-9]*$/u.test(argument)
      if (!hasNumericUser) errors.push('USER must be numeric non-root UID:GID')
    }
    if (
      (upper === 'CMD' || upper === 'ENTRYPOINT') &&
      !argument.startsWith('[')
    ) {
      errors.push('CMD and ENTRYPOINT must use exec form')
    }
    if (upper === 'RUN') {
      if (/\bcorepack\b/u.test(argument)) hasCorepack = true
      if (
        stageCount < totalStages &&
        /\bpnpm\s+install\b[^\n]*--frozen-lockfile\b/u.test(argument)
      ) {
        hasFrozenInstall = true
      }
      if (/\b(?:curl|wget)\b|https?:\/\//iu.test(argument)) {
        errors.push('unverified remote download is forbidden')
      }
      if (
        stageCount === totalStages &&
        /\b(?:apt(?:-get)?|apk|yum|dnf|npm|pnpm|yarn)\s+(?:install|add|ci)\b/iu.test(
          argument,
        )
      ) {
        errors.push('package installation in final stage is forbidden')
      }
    }
  }
  if (stageCount === 0) errors.push('Dockerfile has no FROM')
  if (stageCount < 2) errors.push('Dockerfile must use multiple stages')
  if (!hasCorepack || !hasFrozenInstall) {
    errors.push('builder must use Corepack and frozen pnpm installation')
  }
  if (!hasNumericUser) errors.push('final stage has no numeric non-root USER')
  return errors
}

export function checkImageContracts(root = repositoryRoot) {
  const errors = []
  const contract = JSON.parse(
    readFileSync(join(root, 'deploy', 'images', 'contracts.json'), 'utf8'),
  )
  if (
    contract.schemaVersion !== 1 ||
    contract.targetPlatform !== 'linux/amd64'
  ) {
    errors.push('Unsupported S8 image contract')
  }
  for (const [name, reference] of Object.entries(contract.candidateBases)) {
    if (!digest.test(reference) || /:latest@/iu.test(reference)) {
      errors.push(`${name} is not pinned by an immutable digest`)
    }
  }
  for (const profile of profiles) {
    readAllowlist(profile, root)
    const image = contract.images[profile]
    if (
      image?.name !==
        `loremaster/${profile === 'web-public' ? 'web' : profile}` ||
      !Number.isInteger(image.uid) ||
      image.uid < 10000 ||
      !Number.isInteger(image.gid) ||
      image.gid < 10000 ||
      !image.workdir?.startsWith('/') ||
      !Array.isArray(image.writablePaths)
    ) {
      errors.push(`Incomplete runtime contract for ${profile}`)
    }
  }
  for (const file of readdirSync(join(root, 'deploy', 'images'))) {
    if (/\.dockerfile$/iu.test(file) || /^Dockerfile(?:\..+)?$/u.test(file)) {
      errors.push(
        ...lintDockerfile(
          readFileSync(join(root, 'deploy', 'images', file), 'utf8'),
        ).map((error) => `${file}: ${error}`),
      )
    }
  }
  return errors
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkImageContracts()
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('S8 image and context contracts pass static policy\n')
  }
}
