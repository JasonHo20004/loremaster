export function startTrackedContainer(containers, name, args, docker) {
  // A failed docker run can leave a created container, including its mounts.
  containers.push(name)
  docker(['run', '--detach', '--name', name, ...args])
  return name
}

export function removeTrackedContainer(name, check) {
  if (check(['rm', '--force', name]).status === 0) return true
  // A launch can also fail before creating anything. Confirm absence through a
  // successful listing; an unavailable daemon must still fail cleanup.
  const remaining = check([
    'container',
    'ls',
    '--all',
    '--filter',
    `name=${name}`,
    '--format',
    '{{.Names}}',
  ])
  return (
    remaining.status === 0 &&
    !remaining.stdout.trim().split(/\r?\n/u).includes(name)
  )
}
