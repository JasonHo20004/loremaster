import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import process from 'node:process'

const repositoryRoot = resolve(import.meta.dirname, '..')
const distributionRoot = resolve(repositoryRoot, 'apps/web/dist')
const scannedExtensions = new Set(['.css', '.html', '.js', '.json', '.map'])
const { asterQuayContentPack } =
  await import('../packages/database/dist/content/fixtures/aster-quay.js')
const privateFixtureValues = [
  asterQuayContentPack.answerEntityId,
  asterQuayContentPack.briefing,
  asterQuayContentPack.caseId,
  asterQuayContentPack.stableKey,
  asterQuayContentPack.title,
  ...asterQuayContentPack.regionIds,
  ...asterQuayContentPack.sourceIds,
  ...asterQuayContentPack.regions.flatMap((region) => [
    region.displayName,
    region.id,
  ]),
  ...asterQuayContentPack.entities.flatMap((entity) => [
    entity.id,
    entity.canonicalName,
    entity.role,
    ...entity.aliases,
  ]),
  ...asterQuayContentPack.evidence.flatMap((evidence) => [
    evidence.text,
    evidence.explanation,
  ]),
  ...asterQuayContentPack.sources.flatMap((source) => [
    source.id,
    source.citation,
  ]),
]
const forbiddenMarkers = [
  ...privateFixtureValues.filter((marker) => marker.length >= 8),
  'dailyruneterracase_description',
  'content/fixtures',
  'content/cli',
  '@loremaster/database',
  '@loremaster/domain',
  '@loremaster/config',
  'answerentityid',
  'sourceids',
  'database_url',
  'loremaster_api_cursor_active_key',
  'postgresql://',
].map((marker) => marker.toLowerCase())
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/iu,
]
const expectedBuildContext = [
  'apps/web',
  'packages/config',
  'packages/contracts',
  'packages/domain',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
]

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? files(path) : [path]
      }),
    )
  ).flat()
}

const artifacts = (await files(distributionRoot)).filter((path) =>
  scannedExtensions.has(extname(path)),
)
if (artifacts.length === 0) throw new Error('No public build artifacts found')
if (!artifacts.some((path) => path.endsWith('.map'))) {
  throw new Error('Public build did not include source maps')
}
if (!artifacts.some((path) => path.endsWith('manifest.json'))) {
  throw new Error('Public build did not include a manifest')
}

const buildContext = (
  await readFile(
    resolve(repositoryRoot, 'ops/build-contexts/web-public.allowlist'),
    'utf8',
  )
)
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
if (JSON.stringify(buildContext) !== JSON.stringify(expectedBuildContext)) {
  throw new Error('Public build context does not match the reviewed allowlist')
}

for (const artifact of artifacts) {
  const rawContents = await readFile(artifact, 'utf8')
  const contents = rawContents.toLowerCase()
  for (const marker of forbiddenMarkers) {
    if (contents.includes(marker)) {
      throw new Error(
        `${relative(repositoryRoot, artifact)} disclosed forbidden marker: ${marker}`,
      )
    }
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(rawContents)) {
      throw new Error(
        `${relative(repositoryRoot, artifact)} disclosed a secret-shaped value`,
      )
    }
  }
}

process.stdout.write(
  `Scanned ${artifacts.length} JavaScript, CSS, HTML, manifest, and source-map artifacts; no private markers found.\n`,
)
