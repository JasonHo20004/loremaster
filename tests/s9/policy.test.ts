import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertAdmission,
  assertRuntimePolicy,
  configureCalico,
  documents,
  registryManifest,
  root,
  tool,
} from '../../scripts/s9-common.mjs'
import {
  generateSecrets,
  roleSql,
  secretGroups,
} from '../../scripts/s9-secrets.mjs'
import { runtimeConfig, runtimeSpec } from '../../scripts/s9-runtime-config.mjs'

const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const names = ['api', 'worker', 'observer', 'web', 'migration', 'importer']
describe('S9 runtime resource ceilings', () => {
  it('preserves kind mounts and resources while bounding Redis separately', () => {
    const base = {
      process: { rlimits: [] },
      mounts: [{ destination: '/sys' }],
      linux: { resources: { devices: [{ allow: false }] } },
    }
    const redis = runtimeSpec(base, 64)
    expect(redis.linux.resources.pids.limit).toBe(64)
    expect(runtimeSpec(base).linux.resources.pids.limit).toBe(128)
    expect(redis.mounts).toEqual(base.mounts)
    expect(redis.linux.resources.devices).toEqual(base.linux.resources.devices)
    expect(redis.process.rlimits).toEqual([
      { type: 'RLIMIT_NOFILE', soft: 1024, hard: 1024 },
    ])
    expect(base.process.rlimits).toEqual([])
  })
  it('adds handlers idempotently without changing kind defaults', () => {
    const config =
      'version = 2\n[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]\nSystemdCgroup = true\n'
    const configured = runtimeConfig(config)
    expect(configured.startsWith(config)).toBe(true)
    expect(configured).toContain('containerd.runtimes.loremaster-redis]')
    expect(runtimeConfig(configured)).toBe(configured)
    expect(() => runtimeConfig('version = 3')).toThrow('version changed')
  })
})
function admission() {
  const revision = 'a'.repeat(40)
  const builds = names.map((name) => ({
    image: `loremaster/${name}:s8`,
    revision,
    id: `sha256:${name}`,
    contextSha256: name,
  }))
  const scans = builds.map((build) => ({
    image: build.image,
    id: build.id,
    violations: [] as string[],
    secretFindings: 0,
    configSha256: 'b'.repeat(64),
    scannedAt: new Date().toISOString(),
  }))
  const inspect = (name: string) => ({
    Id: `sha256:${name}`,
    Config: {
      Labels: {
        'org.opencontainers.image.revision': revision,
        'org.loremaster.context.sha256': name,
      },
    },
  })
  return { builds, scans, inspect, revision }
}
describe('S9 immutable promotion admission', () => {
  it('verifies manifest bytes before reading a registry config digest', async () => {
    const { createHash } = await import('node:crypto')
    const bytes = Buffer.from(
      JSON.stringify({ config: { digest: 'sha256:' + 'b'.repeat(64) } }),
    )
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    expect(registryManifest(bytes, digest).config.digest).toBe(
      'sha256:' + 'b'.repeat(64),
    )
    expect(() => registryManifest(Buffer.from('{}'), digest)).toThrow(
      'digest mismatch',
    )
  })
  it('binds six current contexts, scanned config IDs and source revision', () => {
    const { builds, scans, inspect, revision } = admission()
    expect(() =>
      assertAdmission(builds, scans, inspect, revision, (name: string) => name),
    ).not.toThrow()
    expect(() =>
      assertAdmission(builds, scans, inspect, revision, () => 'modified'),
    ).toThrow('admission failed')
    expect(() =>
      assertAdmission(
        builds,
        scans,
        inspect,
        'b'.repeat(40),
        (name: string) => name,
      ),
    ).toThrow('admission failed')
  })
  it.each([
    'config',
    'vulnerability',
    'secret',
    'old-scan',
    'future-scan',
    'missing',
  ])('rejects %s evidence', (failure) => {
    const { builds, scans, inspect, revision } = admission()
    if (failure === 'config') scans[0]!.id = 'another-image'
    if (failure === 'vulnerability') scans[0]!.violations.push('HIGH')
    if (failure === 'secret') scans[0]!.secretFindings = 1
    if (failure === 'old-scan') scans[0]!.scannedAt = '2000-01-01T00:00:00Z'
    if (failure === 'future-scan') scans[0]!.scannedAt = '2099-01-01T00:00:00Z'
    if (failure === 'missing') scans.pop()
    expect(() =>
      assertAdmission(builds, scans, inspect, revision, (name: string) => name),
    ).toThrow()
  })
})
describe('S9 local credential boundary', () => {
  it('generates independent credentials and keeps role grants least privileged', () => {
    const secrets = generateSecrets()
    const second = generateSecrets()
    for (const group of Object.values(secretGroups))
      for (const file of group) {
        expect(secrets[file]).toBeTruthy()
        expect(secrets[file]).not.toEqual(second[file])
      }
    const sql = roleSql(secrets)
    expect(sql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS')
    expect(sql).toContain('GRANT loremaster_cache_worker TO worker')
    expect(sql).toContain('GRANT loremaster_importer TO importer')
    expect(secrets.redis_acl).toContain('user default off')
    expect(Object.values(secretGroups).flat().sort()).toEqual(
      Object.keys(secrets).sort(),
    )
  })
  it('rejects unexpected credential characters before SQL construction', () => {
    const secrets = generateSecrets()
    secrets.api_database_url =
      'postgresql://api:bad%27password@postgres:5432/loremaster'
    expect(() => roleSql(secrets)).toThrow('Invalid generated role credential')
  })
})
describe('S9 controller boundaries', () => {
  it('configures Calico IPAM and an iptables profile for nested kind nodes', () => {
    const source = JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'calico-node' },
      spec: {
        template: {
          spec: {
            volumes: [{ name: 'sys-kernel-security' }, { name: 'state' }],
            containers: [
              {
                name: 'calico-node',
                env: [],
                volumeMounts: [
                  { name: 'sys-kernel-security' },
                  { name: 'state' },
                ],
              },
            ],
          },
        },
      },
    })
    const daemon = configureCalico(source).items[0]
    const pod = daemon.spec.template.spec
    expect(pod.volumes).toEqual([{ name: 'state' }])
    expect(pod.containers[0].env).toContainEqual({
      name: 'CALICO_IPV4POOL_CIDR',
      value: '10.244.0.0/16',
    })
    expect(pod.containers[0].env).toContainEqual({
      name: 'FELIX_BPFENABLED',
      value: 'false',
    })
  })
  it('limits Argo to application resource kinds and one namespace', () => {
    const [project] = documents(read('platform/argocd/project.yaml'))
    expect(project.spec.clusterResourceWhitelist).toEqual([])
    expect(project.spec.destinations).toEqual([
      { namespace: 'loremaster', server: 'https://kubernetes.default.svc' },
    ])
    expect(
      project.spec.namespaceResourceWhitelist.map(
        (entry: { kind: string }) => entry.kind,
      ),
    ).not.toEqual(expect.arrayContaining(['Secret', 'Job', 'RoleBinding']))
    const [application] = documents(read('platform/argocd/application.yaml'))
    expect(application.spec.syncPolicy.automated).toEqual({
      prune: true,
      selfHeal: true,
      allowEmpty: false,
    })
    expect(application.spec.source.helm.valueFiles).toEqual([
      '../../environments/local/images.yaml',
    ])
  })
  it('enforces admission only on application namespace and leaves platform controllers schedulable', () => {
    const resources = documents(read('platform/local/runtime.yaml'))
    const binding = resources.find(
      (resource) => resource.kind === 'ValidatingAdmissionPolicyBinding',
    )
    expect(binding.spec.matchResources.namespaceSelector.matchLabels).toEqual({
      'kubernetes.io/metadata.name': 'loremaster',
    })
    const policy = resources.find(
      (resource) => resource.kind === 'ValidatingAdmissionPolicy',
    )
    expect(policy.spec.failurePolicy).toBe('Fail')
    expect(
      policy.spec.validations.some((validation: { expression: string }) =>
        validation.expression.includes('@sha256:'),
      ),
    ).toBe(true)
  })
  it('keeps the four-node topology and loopback Kubernetes API', () => {
    const [config] = documents(read('platform/local/kind.yaml'))
    expect(config.nodes.map((node: { role: string }) => node.role)).toEqual([
      'control-plane',
      'worker',
      'worker',
      'worker',
    ])
    expect(config.networking.disableDefaultCNI).toBe(true)
    expect(config.networking.apiServerAddress).toBe('127.0.0.1')
  })
})
// pnpm test stays usable without infrastructure tools; test:s9 always renders with Helm.
describe.skipIf(!existsSync(tool('helm')))(
  'S9 rendered workload policy',
  async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { render, save } = await import('../../scripts/s9-common.mjs')
    const renderFixture = () => {
      const directory = mkdtempSync(resolve(tmpdir(), 's9-policy-'))
      const values = resolve(directory, 'values.json')
      save(values, {
        images: Object.fromEntries(
          names.map((name) => [
            name,
            `localhost:5001/loremaster/${name}@sha256:${'a'.repeat(64)}`,
          ]),
        ),
      })
      try {
        return documents(render([], values))
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    it('renders the accepted image UIDs, probes, grace periods and file mounts', () => {
      const resources = renderFixture()
      expect(() => assertRuntimePolicy(resources)).not.toThrow()
      const contracts = JSON.parse(read('deploy/images/contracts.json'))
      for (const name of ['api', 'worker', 'observer', 'web']) {
        const deployment = resources.find(
          (resource) =>
            resource.kind === 'Deployment' && resource.metadata.name === name,
        )
        const pod = deployment.spec.template.spec
        expect(pod.securityContext.runAsUser).toBe(
          contracts.images[name === 'web' ? 'web-public' : name].uid,
        )
        expect(pod.runtimeClassName).toBe('loremaster')
        expect(pod.terminationGracePeriodSeconds).toBe(
          ['api', 'worker'].includes(name) ? 20 : 15,
        )
        expect(pod.containers[0].livenessProbe.httpGet.path).toBe(
          '/health/live',
        )
        expect(pod.containers[0].readinessProbe.httpGet.path).toBe(
          '/health/ready',
        )
      }
      expect(resources.some((resource) => resource.kind === 'Job')).toBe(false)
    })
    it('rejects privilege escalation and mutable images in rendered workloads', () => {
      const resources = renderFixture()
      const deployment = resources.find(
        (resource) => resource.kind === 'Deployment',
      )
      deployment.spec.template.spec.containers[0].image =
        'loremaster/api:latest'
      expect(() => assertRuntimePolicy(resources)).toThrow('Unsafe container')
    })
    it('rejects YAML octal ambiguity in Secret volume permissions', () => {
      const resources = renderFixture()
      const postgres = resources.find(
        (resource) =>
          resource.kind === 'StatefulSet' &&
          resource.metadata.name === 'postgres',
      )
      const credentials = postgres.spec.template.spec.volumes.find(
        (volume: { name: string }) => volume.name === 'credentials',
      )
      expect(credentials.secret.defaultMode).toBe(292)
      credentials.secret.defaultMode = 444
      expect(() => assertRuntimePolicy(resources)).toThrow(
        'Secret mode must be decimal 292',
      )
    })
    it('rejects Redis escaping its 64-PID handler', () => {
      const resources = renderFixture()
      const redis = resources.find(
        (resource) =>
          resource.kind === 'StatefulSet' && resource.metadata.name === 'redis',
      )
      expect(redis.spec.template.spec.runtimeClassName).toBe('loremaster-redis')
      redis.spec.template.spec.runtimeClassName = 'loremaster'
      expect(() => assertRuntimePolicy(resources)).toThrow('Unsafe pod: redis')
    })
    it('allows only the reviewed peer-to-peer network paths', () => {
      const resources = renderFixture()
      for (const [name, sources, port] of [
        ['api', ['web'], 3000],
        ['postgres', ['api', 'worker', 'migration', 'importer'], 5432],
        ['redis', ['api', 'worker', 'observer'], 6379],
      ] as const) {
        const policy = resources.find(
          (resource) =>
            resource.kind === 'NetworkPolicy' &&
            resource.metadata.name === `${name}-ingress`,
        )
        expect(
          policy.spec.ingress[0].from[0].podSelector.matchExpressions[0].values,
        ).toEqual(sources)
        expect(policy.spec.ingress[0].ports[0].port).toBe(port)
      }
    })
  },
)
