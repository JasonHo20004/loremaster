import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  copyFileSync,
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { createHash } from 'node:crypto'
const [phase, profile] = process.argv.slice(2)
function files(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const relative = join(prefix, entry.name)
      return entry.isDirectory()
        ? files(root, relative)
        : [relative.replaceAll('\\', '/')]
    },
  )
}
if (phase === 'prepare') {
  for (const parent of ['apps', 'packages']) {
    if (!existsSync(parent)) continue
    for (const name of readdirSync(parent)) {
      const directory = join(parent, name),
        manifest = join(directory, 'package.json')
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      pkg.files = existsSync(join(directory, 'dist'))
        ? files(directory, 'dist').filter(
            (file) => file.endsWith('.js') && !file.includes('/fixtures/'),
          )
        : []
      if (pkg.name === '@loremaster/queue')
        pkg.files.push('policy/bullmq-script-inventory.json')
      if (pkg.name === '@loremaster/database') {
        const allowed =
          profile === 'migration'
            ? /^dist\/(pool|migrate)\.js$/u
            : profile === 'importer'
              ? /^dist\/(pool\.js|content\/(import|schema|validate)\.js)$/u
              : /^dist\/(pool\.js|runtime\.js|deadline\.js|gameplay\/.*\.js|identity\/.*\.js)$/u
        pkg.files = pkg.files.filter((file) => allowed.test(file))
        if (['migration', 'importer'].includes(profile))
          delete pkg.dependencies['@loremaster/domain']
      }
      if (pkg.files.length === 0)
        throw Error('No compiled runtime files: ' + pkg.name)
      writeFileSync(manifest, JSON.stringify(pkg) + '\n')
    }
  }
} else if (phase === 'package') {
  packageRuntime(profile)
} else if (phase === 'clean') {
  const clean = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (
        /^(bin|tests?|__tests__|fixtures|docs?|examples?|benchmarks?|\.github|\.cache)$/iu.test(
          entry.name,
        ) ||
        /\.(?:ts|tsx|map|cpp|cc|c|h|gyp|gypi|sh)$/u.test(entry.name) ||
        ['.modules.yaml', 'lock.yaml'].includes(entry.name)
      ) {
        rmSync(target, { recursive: entry.isDirectory(), force: true })
      } else if (entry.isDirectory()) clean(target)
    }
  }
  clean('/out')
  if (['migration', 'importer'].includes(profile)) {
    const source = readFileSync('deploy/images/operator.mjs', 'utf8')
    if (!source.includes('process.env.LOREMASTER_OPERATOR'))
      throw Error('Operator source changed')
    writeFileSync(
      '/out/' + profile + '.mjs',
      source.replace(
        'process.env.LOREMASTER_OPERATOR',
        JSON.stringify(profile),
      ),
    )
    copyFileSync('packages/config/dist/secret-file.js', '/out/secret-file.js')
  }
} else throw Error('Unknown staging phase')

function packageRuntime(profile) {
  const targets = {
    api: 'apps/api',
    worker: 'apps/worker',
    observer: 'apps/queue-observer',
    migration: 'packages/database',
    importer: 'packages/database',
  }
  const visited = new Map()
  function dependency(base, name) {
    let current = base
    while (true) {
      const candidate = join(current, 'node_modules', name)
      if (existsSync(candidate)) return realpathSync(candidate)
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
  function copy(source, destination) {
    source = realpathSync(source)
    if (visited.has(source)) return visited.get(source)
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    destination ??= join(
      '/out/node_modules/.runtime',
      createHash('sha256')
        .update(relative(process.cwd(), source))
        .digest('hex')
        .slice(0, 16),
    )
    visited.set(source, destination)
    mkdirSync(destination, { recursive: true })
    if (pkg.name.startsWith('@loremaster/')) {
      copyFileSync(
        join(source, 'package.json'),
        join(destination, 'package.json'),
      )
      for (const file of pkg.files) {
        const output = join(destination, file)
        mkdirSync(dirname(output), { recursive: true })
        copyFileSync(join(source, file), output)
      }
    } else {
      cpSync(source, destination, {
        recursive: true,
        filter: (input) =>
          !relative(source, input).split(/[\\/]/u).includes('node_modules'),
      })
    }
    for (const name of new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ])) {
      // S7 deliberately uses MessagePack's JavaScript implementation.
      if (name === 'msgpackr-extract') continue
      const location = dependency(source, name)
      if (!location) {
        if (
          pkg.optionalDependencies?.[name] ||
          pkg.peerDependenciesMeta?.[name]?.optional
        )
          continue
        throw Error('Missing installed production dependency: ' + name)
      }
      const target = copy(location)
      const link = join(destination, 'node_modules', name)
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(relative(dirname(link), target), link, 'dir')
    }
    return destination
  }
  const selected = targets[profile]
  if (!selected) throw Error('Unknown runtime profile')
  copy(selected, '/out')
}
