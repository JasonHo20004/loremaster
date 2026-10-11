import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { buildContext, profiles, repositoryRoot } from './s8-context.mjs'
export function buildImage(profile) {
  if (!profiles.includes(profile)) throw Error('Unknown image profile')
  const temporary = mkdtempSync(join(tmpdir(), 'loremaster-s8-build-'))
  try {
    const context = join(temporary, 'context')
    const manifest = buildContext(profile, context)
    const digest = createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex')
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim()
    const epoch = git('show', '-s', '--format=%ct', 'HEAD')
    const revision = git('rev-parse', 'HEAD')
    const created = new Date(Number(epoch) * 1000).toISOString()
    const image =
      'loremaster/' + (profile === 'web-public' ? 'web' : profile) + ':s8'
    const args = [
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '--provenance=false',
      '--sbom=false',
      '--output',
      'type=docker,rewrite-timestamp=true,dest=' + join(temporary, 'image.tar'),
      '--tag',
      image,
      '--build-arg',
      'SOURCE_DATE_EPOCH=' + epoch,
      '--build-arg',
      'VCS_REF=' + revision,
      '--build-arg',
      'BUILD_CREATED=' + created,
      '--label',
      'org.loremaster.context.sha256=' + digest,
      '--file',
      join(context, 'deploy/images', profile + '.dockerfile'),
      context,
    ]
    execFileSync('docker', args, { stdio: 'inherit', timeout: 1200000 })
    execFileSync('docker', ['load', '--input', join(temporary, 'image.tar')], {
      stdio: 'inherit',
      timeout: 120000,
    })
    const id = execFileSync(
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', image],
      { encoding: 'utf8' },
    ).trim()
    return { profile, image, id, contextSha256: digest, revision, created }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const selected = process.argv.slice(2)
  if (!selected.length) throw Error('Supply one or more image profiles')
  const result = selected.map(buildImage)
  const output = join(repositoryRoot, '.cache', 's8-build-results.json')
  // The evidence path is private local build output, never part of a context.
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(repositoryRoot, '.cache'), { recursive: true })
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
