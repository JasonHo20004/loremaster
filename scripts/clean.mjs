import { rm } from 'node:fs/promises'
import { cwd } from 'node:process'
import { resolve } from 'node:path'

await rm(resolve(cwd(), 'dist'), { force: true, recursive: true })
