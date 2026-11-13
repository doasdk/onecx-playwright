import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const identifier = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)'
const semver = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`)
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

export function readJson(root, file) {
  try {
    return JSON.parse(readFileSync(join(root, file), 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`)
  }
}

export function validateVersion(value, name) {
  if (typeof value !== 'string' || value.trim() !== value || !semver.test(value)) throw new Error(`Invalid ${name}: expected an exact semantic version`)
  return value
}

export function imageVersion(image, repository, prefix = '') {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = typeof image === 'string' && image.match(
    new RegExp(`^${escaped}:${prefix}((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))-[a-z][a-z0-9.-]*@sha256:[a-f0-9]{64}$`)
  )
  if (!match || image.trim() !== image) throw new Error(`Invalid ${repository} image: expected a full versioned tag and sha256 digest`)
  return match[1]
}

export function loadVersions(root) {
  const config = readJson(root, 'versions.json')
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Invalid versions.json: expected an object')
  for (const key of ['release', 'integrationTests', 'allure']) validateVersion(config[key], key)
  const node = imageVersion(config.nodeImage, 'node')
  const playwright = imageVersion(config.playwrightImage, 'mcr.microsoft.com/playwright', 'v')
  const baseline = readJson(root, 'orchestrator/compatibility/compatibility.json')
  if (config.integrationTests !== baseline?.integrationTests) {
    throw new Error('Integration dependency is not supported; review adapters and update compatibility baseline after verifying')
  }
  return { ...config, node, playwright }
}

export function generatedFiles(root, versions) {
  const orchestrator = readJson(root, 'orchestrator/package.json')
  orchestrator.version = versions.release
  orchestrator.dependencies['@onecx/integration-tests'] = versions.integrationTests
  orchestrator.dependencies['allure-commandline'] = versions.allure
  const smoke = readJson(root, 'tests/smoke/package.json')
  smoke.devDependencies['@playwright/test'] = versions.playwright
  const template = readFileSync(join(root, 'scripts/Dockerfile.template'), 'utf8').replace(/\r\n/g, '\n')
  const dockerfile = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(versions, key)) throw new Error(`Unknown Dockerfile template variable: ${key}`)
    return versions[key]
  })
  return {
    Dockerfile: dockerfile,
    '.node-version': `${versions.node}\n`,
    'orchestrator/package.json': json(orchestrator),
    'tests/smoke/package.json': json(smoke)
  }
}

export function checkLock(root, directory) {
  const manifest = readJson(root, `${directory}/package.json`)
  const lock = readJson(root, `${directory}/package-lock.json`)
  const locked = lock.packages?.['']
  for (const field of ['name', 'version', 'dependencies', 'devDependencies']) {
    if (!isDeepStrictEqual(locked?.[field], manifest[field])) {
      throw new Error(`Stale ${directory}/package-lock.json: root ${field} differs from package.json`)
    }
  }
  if (lock.name !== manifest.name || lock.version !== manifest.version || lock.lockfileVersion !== 3) {
    throw new Error(`Stale ${directory}/package-lock.json: invalid lock metadata`)
  }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  if (dependencies['@playwright/test']) {
    dependencies.playwright = dependencies['@playwright/test']
    dependencies['playwright-core'] = dependencies['@playwright/test']
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (lock.packages[`node_modules/${name}`]?.version !== version) {
      throw new Error(`Stale ${directory}/package-lock.json: installed ${name} differs from package.json`)
    }
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue
    if (entry.link || typeof entry.integrity !== 'string' ||
        typeof entry.resolved !== 'string' || !/^https:\/\/registry\.npmjs\.org\/[^?#]+$/.test(entry.resolved)) {
      throw new Error(`Unsafe ${directory}/package-lock.json entry: ${name}; expected an integrity-checked public npm registry URL`)
    }
  }
}

export function installLock(root, directory, execute = spawnSync, platform = process.platform) {
  // npm.cmd cannot be spawned directly on Windows without a shell.
  const windows = platform === 'win32'
  const result = execute(windows ? 'npm.cmd' : 'npm', [
    'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'
  ], { cwd: join(root, directory), stdio: 'inherit', shell: windows })
  if (result.error || result.status !== 0) {
    throw new Error(`npm lock update failed for ${directory}: ${result.error?.message ?? result.status}; retry npm install --package-lock-only --ignore-scripts --no-audit --no-fund in ${directory}`)
  }
}

export function synchronize(root, { check = false, install = installLock } = {}) {
  const files = generatedFiles(root, loadVersions(root))
  const changedManifests = []
  for (const [file, contents] of Object.entries(files)) {
    let actual
    try { actual = readFileSync(join(root, file), 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (actual?.replace(/\r\n/g, '\n') === contents) continue
    if (check) throw new Error(`Stale generated file: ${file}; run node scripts/versions.mjs sync`)
    writeFileSync(join(root, file), contents)
    if (file.endsWith('/package.json')) changedManifests.push(dirname(file))
  }
  for (const directory of changedManifests) install(root, directory)
  for (const directory of ['orchestrator', 'tests/smoke']) checkLock(root, directory)
}

export function main(args, root = defaultRoot, install = installLock) {
  const [command, version, ...extra] = args
  if (!['check', '--check', 'sync', 'release'].includes(command) ||
      extra.length || (command === 'release' ? !version : version !== undefined)) {
    throw new Error('Usage: node scripts/versions.mjs check|sync|release <version>')
  }
  if (command === 'release') {
    validateVersion(version, 'release')
    loadVersions(root)
    const config = readJson(root, 'versions.json')
    config.release = version
    writeFileSync(join(root, 'versions.json'), json(config))
  }
  synchronize(root, { check: command === 'check' || command === '--check', install })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`versions: ${error.message}`)
    process.exitCode = 1
  }
}
