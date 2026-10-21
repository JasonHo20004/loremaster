import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export function assertFreshSecretVolume(project, docker) {
  // A daemon failure is not evidence that a retained database is absent.
  const volumes = docker(['volume', 'ls', '--format', '{{.Name}}'])
  if (volumes.split(/\r?\n/u).includes(`${project}_postgres_data`))
    throw Error(
      'PostgreSQL volume exists but secrets are missing; restore the original secrets',
    )
}

export function validateContentFile(path) {
  if (!isAbsolute(path))
    throw Error('LOREMASTER_S8_CONTENT_FILE must be an absolute path')
  const content = lstatSync(path)
  if (content.isSymbolicLink() || !content.isFile())
    throw Error('LOREMASTER_S8_CONTENT_FILE must be a regular file')
  if (content.size === 0 || content.size > 262144)
    throw Error('LOREMASTER_S8_CONTENT_FILE must contain 1 to 262144 bytes')
}
