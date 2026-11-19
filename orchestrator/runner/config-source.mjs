import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const keys = new Set(['$schema', 'schemaVersion', 'extends', 'platform', 'test', 'matrix', 'components', 'environment', 'artifacts'])

export function assertConfigSourcePath(file, sourceRoot) {
  if (!sourceRoot) return
  const path = relative(realpathSync(sourceRoot), realpathSync(file))
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('Configuration files must remain inside the staged source directory.')
  }
}

export function loadConfigSource(file, ancestors = [], inherited = false, sourceRoot) {
  if (!existsSync(file)) throw new Error(`Orchestrator configuration file does not exist: ${file}`)
  assertConfigSourcePath(file, sourceRoot)
  const identity = realpathSync(file)
  if (ancestors.includes(identity)) throw new Error(`Configuration extends cycle: ${[...ancestors, identity].join(' -> ')}`)
  let source
  try {
    source = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('Orchestrator configuration must contain valid JSON.')
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source) || source.schemaVersion !== 1) {
    throw new Error('Configuration must be an object with schemaVersion: 1.')
  }
  const extending = Object.hasOwn(source, 'extends')
  if (inherited || extending) {
    for (const key of Object.keys(source)) {
      if (!keys.has(key)) throw new Error(`Unknown configuration key: ${key}`)
    }
  }
  let base = { config: {}, origins: {} }
  if (extending) {
    if (typeof source.extends !== 'string' || !source.extends.trim()) {
      throw new Error('Configuration.extends must name an orchestrator JSON file.')
    }
    base = loadConfigSource(resolve(dirname(file), source.extends), [...ancestors, identity], true, sourceRoot)
  }
  const { extends: ignored, ...own } = source
  return {
    config: { ...base.config, ...own },
    origins: { ...base.origins, ...Object.fromEntries(Object.keys(own).map((key) => [key, dirname(file)])) },
  }
}
