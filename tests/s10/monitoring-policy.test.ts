import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  documents,
  render,
  root,
  save,
  tool,
} from '../../scripts/s9-common.mjs'
import {
  dashboardConfigMaps,
  imageReferences,
  monitoringVersions,
  pinImages,
} from '../../scripts/s10-monitoring.mjs'

interface Resource {
  readonly kind: string
  readonly metadata: {
    readonly name: string
    readonly labels?: Record<string, string>
  }
  readonly spec?: Record<string, unknown>
}

const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const digest = `sha256:${'b'.repeat(64)}`
const temporary = mkdtempSync(join(tmpdir(), 'loremaster-s10-policy-'))
afterAll(() => rmSync(temporary, { recursive: true, force: true }))

function renderedApplication(): Resource[] {
  const values = join(temporary, 'images.json')
  save(values, {
    images: Object.fromEntries(
      ['api', 'worker', 'observer', 'web', 'migration', 'importer'].map(
        (name) => [
          name,
          `localhost:5001/loremaster/${name}@sha256:${'a'.repeat(64)}`,
        ],
      ),
    ),
  })
  return documents(render([], values)) as Resource[]
}

describe('S10 monitoring image pinning', () => {
  it('pins every listed reference once, including operator arguments', () => {
    const rendered = [
      'image: "quay.io/prometheus/prometheus:v3.15.0-distroless"',
      '  - --prometheus-config-reloader=quay.io/prometheus-operator/prometheus-config-reloader:v0.94.1',
      `image: quay.io/prometheus/prometheus:v3.15.0-distroless@${digest}`,
    ].join('\n')
    const pinned = pinImages(rendered, {
      'quay.io/prometheus/prometheus:v3.15.0-distroless': digest,
      'quay.io/prometheus-operator/prometheus-config-reloader:v0.94.1': digest,
    })

    expect(imageReferences(pinned)).toEqual([
      `quay.io/prometheus/prometheus:v3.15.0-distroless@${digest}`,
      `quay.io/prometheus-operator/prometheus-config-reloader:v0.94.1@${digest}`,
      `quay.io/prometheus/prometheus:v3.15.0-distroless@${digest}`,
    ])
  })

  it('rejects images without a reviewed digest and malformed digests', () => {
    expect(() =>
      pinImages('image: docker.io/library/busybox:1.37', {}),
    ).toThrow('Unpinned monitoring images: docker.io/library/busybox:1.37')
    expect(() => pinImages('image: a:1', { 'a:1': 'sha256:short' })).toThrow(
      'Invalid monitoring image digest',
    )
    expect(() =>
      pinImages('image: quay.io/x/prom:v1.10', {
        'quay.io/x/prom:v1.1': digest,
      }),
    ).toThrow('Unpinned monitoring images: quay.io/x/prom:v1.10')
  })

  it('pins the chart archive and every image by sha256', () => {
    const { charts, images } = monitoringVersions()
    expect(charts.map((chart) => chart.release)).toEqual([
      'monitoring',
      'loki',
      'alloy',
    ])
    for (const chart of charts) {
      expect(chart.url).toMatch(
        /^https:\/\/github\.com\/(prometheus-community|grafana)\/helm-charts\/releases\/download\//u,
      )
      expect(chart.url).toContain(`${chart.name}-${chart.version}.tgz`)
      expect(chart.sha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(
        existsSync(resolve(root, 'platform/monitoring', chart.values)),
      ).toBe(true)
    }
    for (const [reference, value] of Object.entries(images)) {
      expect(reference).toMatch(/^[a-z0-9.-]+\/[^@\s]+:[^@\s]+$/u)
      expect(value).toMatch(/^sha256:[0-9a-f]{64}$/u)
    }
  })
})

describe('S10 alert rules', () => {
  it('gives every alert a severity and an existing runbook', () => {
    const [rule] = documents(read('platform/monitoring/rules.yaml')) as {
      kind: string
      spec: {
        groups: {
          rules: {
            alert?: string
            labels?: { severity?: string }
            annotations?: { runbook_url?: string; summary?: string }
          }[]
        }[]
      }
    }[]
    expect(rule?.kind).toBe('PrometheusRule')
    const alerts = rule!.spec.groups.flatMap((group) =>
      group.rules.filter((item) => item.alert !== undefined),
    )
    expect(alerts.length).toBeGreaterThan(10)
    for (const alert of alerts) {
      expect(['page', 'ticket']).toContain(alert.labels?.severity)
      expect(alert.annotations?.summary).toBeTruthy()
      const runbook = alert.annotations?.runbook_url ?? ''
      expect(runbook).toMatch(/^docs\/runbooks\/[a-z-]+\.md$/u)
      expect(existsSync(resolve(root, runbook))).toBe(true)
      expect(read('docs/runbooks/README.md')).toContain(
        runbook.replace('docs/runbooks/', ''),
      )
    }
    // Queue alerts never page: gameplay never waits on the queue.
    for (const alert of alerts.filter((item) =>
      item.alert?.startsWith('LoremasterQueue'),
    ))
      expect(alert.labels?.severity).toBe('ticket')
  })
})

describe('S10 monitoring configuration', () => {
  it('keeps credentials out of the chart values', () => {
    const values = read('platform/monitoring/values.yaml')
    expect(values).toContain('existingSecret: grafana-admin')
    expect(values).not.toMatch(/adminPassword|password:/iu)
  })

  it('renders dashboards as sidecar ConfigMaps that query only known series', () => {
    const maps = dashboardConfigMaps()
    expect(maps.map((map) => map.metadata.name)).toEqual([
      'dashboard-loremaster-api',
      'dashboard-loremaster-queue',
    ])
    const known =
      /\b(loremaster_api_[a-z_]+|loremaster_queue_[a-z_]+|process_[a-z_]+|nodejs_[a-z0-9_]+|kube_[a-z_]+|container_[a-z_]+)\b/gu
    for (const file of readdirSync(
      resolve(root, 'platform/monitoring/dashboards'),
    )) {
      const dashboard = JSON.parse(
        read(`platform/monitoring/dashboards/${file}`),
      ) as { panels: { targets: { expr: string }[] }[] }
      for (const panel of dashboard.panels)
        for (const target of panel.targets)
          expect(target.expr.match(known)?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

// pnpm test stays usable without infrastructure tools; CI runs test:s10
// after `pnpm s9 tools`, so these always render with Helm there.
describe.skipIf(!existsSync(tool('helm')))('S10 rendered scrape access', () => {
  it('scrapes only application Services that expose the named metrics ports', () => {
    const monitors = documents(read('platform/monitoring/scrape.yaml')) as {
      spec: {
        selector: { matchLabels: Record<string, string> }
        endpoints: { port: string; path: string }[]
      }
    }[]
    const services = renderedApplication().filter(
      (resource) => resource.kind === 'Service',
    )
    for (const monitor of monitors) {
      const service = services.find(
        (resource) =>
          resource.metadata.labels?.['app.kubernetes.io/name'] ===
          monitor.spec.selector.matchLabels['app.kubernetes.io/name'],
      )
      expect(service).toBeDefined()
      const ports = (service?.spec?.ports as { name: string }[]).map(
        (port) => port.name,
      )
      for (const endpoint of monitor.spec.endpoints) {
        expect(ports).toContain(endpoint.port)
        expect(endpoint.path).toBe('/metrics')
      }
    }
  })

  it('admits scrapes only from Prometheus in the monitoring namespace', () => {
    const resources = renderedApplication()
    const policy = resources.find(
      (resource) =>
        resource.kind === 'NetworkPolicy' &&
        resource.metadata.name === 'monitoring-scrape',
    )
    expect(policy?.spec).toEqual({
      podSelector: {
        matchExpressions: [
          {
            key: 'app.kubernetes.io/name',
            operator: 'In',
            values: ['api', 'observer'],
          },
        ],
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' },
              },
              podSelector: {
                matchLabels: { 'app.kubernetes.io/name': 'prometheus' },
              },
            },
          ],
          ports: [
            { port: 9464, protocol: 'TCP' },
            { port: 3002, protocol: 'TCP' },
          ],
        },
      ],
    })
    const api = resources.find(
      (resource) =>
        resource.kind === 'Deployment' && resource.metadata.name === 'api',
    ) as unknown as {
      spec: {
        template: {
          spec: {
            containers: { env: { name: string; value: string }[] }[]
          }
        }
      }
    }
    expect(api.spec.template.spec.containers[0]?.env).toEqual(
      expect.arrayContaining([
        { name: 'LOREMASTER_API_METRICS_PORT', value: '9464' },
        { name: 'LOREMASTER_API_METRICS_HOST', value: '0.0.0.0' },
      ]),
    )
  })
})
