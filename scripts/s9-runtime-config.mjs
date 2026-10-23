// Preserve kind's cgroup and mount defaults while adding application-only runtimes.
export function runtimeSpec(base, pids = 128) {
  const spec = globalThis.structuredClone(base)
  spec.process.rlimits = [{ type: 'RLIMIT_NOFILE', soft: 1024, hard: 1024 }]
  spec.linux ??= {}
  spec.linux.resources ??= {}
  spec.linux.resources.pids = { limit: pids }
  return spec
}

export function runtimeConfig(config) {
  if (!/^version = 2$/mu.test(config))
    throw Error('Pinned kind containerd configuration version changed')
  let result = config
  for (const name of ['loremaster', 'loremaster-redis']) {
    if (result.includes(`containerd.runtimes.${name}]`)) continue
    result += `\n[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.${name}]\nruntime_type = "io.containerd.runc.v2"\nbase_runtime_spec = "/etc/containerd/${name}-spec.json"\n[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.${name}.options]\nSystemdCgroup = true\n`
  }
  return result
}
