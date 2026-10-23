import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { run, state, versions } from './s9-common.mjs'

export async function download(url, digest, output) {
  const response = await globalThis.fetch(url, {
    signal: globalThis.AbortSignal.timeout(120000),
  })
  if (!response.ok) throw Error(`Download failed: ${response.status} ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw Error('Download checksum mismatch: ' + url)
  mkdirSync(resolve(output, '..'), { recursive: true })
  writeFileSync(output, bytes)
  return bytes
}
export async function installTools() {
  const platform = process.platform
  const checksums = versions.tools[platform]
  if (!checksums || process.arch !== 'x64')
    throw Error('S9 tools support Linux/Windows amd64')
  const os = platform === 'win32' ? 'windows' : 'linux'
  const kindPath = resolve(
    state,
    'tools',
    platform === 'win32' ? 'kind.exe' : 'kind',
  )
  await download(
    `https://kind.sigs.k8s.io/dl/v${versions.kind}/kind-${os}-amd64`,
    checksums.kind,
    kindPath,
  )
  chmodSync(kindPath, 0o755)
  const kubectlPath = resolve(
    state,
    'tools',
    'kubectl' + (platform === 'win32' ? '.exe' : ''),
  )
  await download(
    `https://dl.k8s.io/release/v${versions.kubectl}/bin/${os}/amd64/kubectl${platform === 'win32' ? '.exe' : ''}`,
    checksums.kubectl,
    kubectlPath,
  )
  chmodSync(kubectlPath, 0o755)
  const archive = resolve(
    state,
    'tools',
    platform === 'win32' ? 'helm.zip' : 'helm.tar.gz',
  )
  await download(
    `https://get.helm.sh/helm-v${versions.helm}-${os}-amd64.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
    checksums.helm,
    archive,
  )
  const destination = resolve(state, 'tools/helm')
  mkdirSync(destination, { recursive: true })
  // bsdtar on Windows also reads zip; no global install or PATH edit.
  run('tar', ['-xf', archive, '-C', destination])
  chmodSync(
    resolve(
      destination,
      `${os}-amd64/helm${platform === 'win32' ? '.exe' : ''}`,
    ),
    0o755,
  )
}
