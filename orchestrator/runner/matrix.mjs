import { existsSync, readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { dirname, isAbsolute, resolve } from 'node:path'
import { URL } from 'node:url'

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseJson(content, label) {
  try {
    return JSON.parse(content)
  } catch {
    throw new Error(`${label} must contain valid JSON.`)
  }
}

export function validateImage(image, label = 'Image') {
  if (
    typeof image !== 'string' ||
    !/^[a-z0-9][a-z0-9._:/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*|@sha256:[a-f0-9]{64})$/.test(image)
  ) {
    throw new Error(`${label} must be a Docker reference with an explicit tag or sha256 digest.`)
  }
  return image
}

function findCustomContainer(platformConfig, alias) {
  const matches = []
  for (const kind of ['service', 'bff', 'ui']) {
    for (const container of platformConfig.container?.[kind] || []) {
      if (container.networkAlias === alias) matches.push(container)
    }
  }
  if (matches.length > 1) throw new Error(`Container alias ${alias} is ambiguous in platform configuration.`)
  return matches[0]
}

export function getComponentImageTarget(platformConfig, key, components) {
  const alias = components[key]
  const custom = findCustomContainer(platformConfig, alias)
  if (custom) return custom
  const [group, name] = key.split('.')
  const override = platformConfig.platformOverrides?.[group]?.[name]
  if (!isRecord(override)) throw new Error(`Component ${key} is not present in the platform overrides.`)
  return override
}

export function validateSelection(selection, config) {
  if (!isRecord(selection)) throw new Error('Matrix selection must be a JSON object.')
  for (const [key, image] of Object.entries(selection)) {
    if (!Object.hasOwn(config.components, key)) {
      throw new Error(`Matrix component ${key} is not mapped in configuration.components.`)
    }
    if (!Object.hasOwn(config.matrix ?? {}, key)) {
      throw new Error(`Matrix component ${key} is not declared in configuration.matrix.`)
    }
    getComponentImageTarget(config.platformConfig, key, config.components)
    validateImage(image, `Matrix image for ${key}`)
  }
  return selection
}

export function decodeSelection(encoded, config) {
  if (!encoded) return {}
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Invalid base64 matrix selection.')
  }
  return validateSelection(parseJson(Buffer.from(encoded, 'base64').toString('utf8'), 'Matrix selection'), config)
}

export function expandMatrix(matrix, config) {
  if (!isRecord(matrix) || Object.keys(matrix).length === 0) {
    throw new Error('Configuration.matrix must be a non-empty object.')
  }

  let combinations = [{}]
  for (const [key, images] of Object.entries(matrix)) {
    if (!Object.hasOwn(config.components, key)) {
      throw new Error(`Matrix component ${key} is not mapped in configuration.components.`)
    }
    getComponentImageTarget(config.platformConfig, key, config.components)
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error(`Matrix component ${key} requires at least one image.`)
    }
    images.forEach((image) => validateImage(image, `Matrix image for ${key}`))
    if (new Set(images).size !== images.length) {
      throw new Error(`Duplicate images for matrix component ${key}.`)
    }
    combinations = combinations.flatMap((selection) => images.map((image) => ({ ...selection, [key]: image })))
    if (combinations.length > 256) {
      throw new Error('Matrix expands to more than 256 combinations.')
    }
  }
  return combinations
}

function validateComponents(source, platformConfig) {
  if (!isRecord(source)) throw new Error('Configuration.components must map platform component keys to aliases.')
  for (const [key, alias] of Object.entries(source)) {
    if (!/^[a-zA-Z][A-Za-z0-9_-]*(?:\.[a-zA-Z][A-Za-z0-9_-]*)+$/.test(key)) {
      throw new Error(`Invalid platform component key: ${key}`)
    }
    if (typeof alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(alias)) {
      throw new Error(`Component ${key} must map to a valid platform container alias.`)
    }
    const target = getComponentImageTarget(platformConfig, key, source)
    validateImage(target.image, `Platform image for ${key}`)
  }
  const aliases = Object.values(source)
  if (new Set(aliases).size !== aliases.length) {
    throw new Error('Configuration.components aliases must be unique.')
  }
  return source
}

function loadJsonFile(file, label) {
  if (!existsSync(file)) throw new Error(`${label} file does not exist: ${file}`)
  return parseJson(readFileSync(file, 'utf8'), label)
}

export function loadConfig(configPath, env = process.env) {
  if (typeof configPath !== 'string' || !configPath.trim()) throw new Error('Specify --config <path>.')
  const absoluteConfigPath = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)
  const config = loadJsonFile(absoluteConfigPath, 'Orchestrator configuration')
  if (!isRecord(config) || config.schemaVersion !== 1) {
    throw new Error('Configuration must be an object with schemaVersion: 1.')
  }
  if (!isRecord(config.platform) || typeof config.platform.config !== 'string' || !config.platform.config.trim()) {
    throw new Error('Configuration.platform.config must name a platform JSON file.')
  }

  const configDirectory = dirname(absoluteConfigPath)
  const platformPath = isAbsolute(config.platform.config)
    ? config.platform.config
    : resolve(configDirectory, config.platform.config)
  const platformFile = loadJsonFile(platformPath, 'Platform configuration')
  if (!isRecord(platformFile) || !isRecord(platformFile.platformConfig)) {
    throw new Error('Platform configuration must contain a platformConfig object.')
  }
  const e2eContainers = platformFile.platformConfig.container?.e2e
  if (!Array.isArray(e2eContainers) || e2eContainers.length === 0 || !e2eContainers[0]?.networkAlias) {
    throw new Error('Platform configuration must define container.e2e[0].networkAlias.')
  }
  let matrix = config.matrix
  let matrixPath
  if (typeof matrix === 'string') {
    matrixPath = isAbsolute(matrix) ? matrix : resolve(configDirectory, matrix)
    matrix = loadJsonFile(matrixPath, 'Version matrix')
  }
  if (matrix !== undefined && (!isRecord(matrix) || Object.keys(matrix).length === 0)) {
    throw new Error('Configuration.matrix must be a non-empty object or a path to a matrix JSON file.')
  }

  const test = config.test
  if (!isRecord(test)) throw new Error('Configuration.test must be an object.')
  const image = validateImage(test.image, 'Configuration.test.image')
  const script = test.script ?? 'tests:gui'
  if (typeof script !== 'string' || !/^[A-Za-z0-9:_-]+$/.test(script)) {
    throw new Error('Configuration.test.script must be a valid npm script name.')
  }
  const timeoutMs = test.timeoutMs ?? 1_800_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('Configuration.test.timeoutMs must be an integer of at least 1000.')
  }
  if (test.baseUrl !== undefined) {
    if (typeof test.baseUrl !== 'string') throw new Error('Configuration.test.baseUrl must be an HTTP(S) URL.')
    let target
    try {
      target = new URL(test.baseUrl)
    } catch {
      throw new Error('Configuration.test.baseUrl must be an HTTP(S) URL.')
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Configuration.test.baseUrl must be an HTTP(S) URL without embedded credentials.')
    }
  }
  const environment = config.environment ?? 'container'
  if (typeof environment !== 'string' || !environment.trim()) {
    throw new Error('Configuration.environment must be a non-empty string.')
  }
  const artifacts = config.artifacts ?? {}
  if (!isRecord(artifacts) || (artifacts.capturePrivate !== undefined && typeof artifacts.capturePrivate !== 'boolean')) {
    throw new Error('Configuration.artifacts.capturePrivate must be a boolean.')
  }

  const normalized = {
    ...config,
    test: { ...test, image: validateImage(env.E2E_IMAGE || image, 'Effective test image'), script, timeoutMs },
    environment,
    artifacts: { capturePrivate: artifacts.capturePrivate ?? false },
    matrix,
    matrixPath,
    components: validateComponents(config.components, platformFile.platformConfig),
    configPath: absoluteConfigPath,
    configDirectory,
    platformPath,
    platformFile,
    platformConfig: platformFile.platformConfig,
  }
  if (platformFile.platformConfig.importData && !Object.hasOwn(normalized.components, 'core.importmanager')) {
    throw new Error('components must map core.importmanager when platform data import is enabled.')
  }

  if (normalized.matrix !== undefined) {
    if (!isRecord(normalized.matrix) || Object.keys(normalized.matrix).length === 0) {
      throw new Error('Configuration.matrix must be a non-empty object when provided.')
    }
    for (const key of Object.keys(normalized.matrix)) {
      if (!Object.hasOwn(normalized.components, key)) {
        throw new Error(`Matrix component ${key} is not mapped in configuration.components.`)
      }
      getComponentImageTarget(normalized.platformConfig, key, normalized.components)
    }
  }
  return normalized
}

export function runtimeJson(value, file, label, configDirectory) {
  if (value !== undefined && file !== undefined) {
    throw new Error(`Specify only the JSON value or the file for ${label}.`)
  }
  let content = value
  if (file !== undefined) {
    const filePath = isAbsolute(file) ? file : resolve(configDirectory, file)
    if (!existsSync(filePath)) throw new Error(`${label} JSON file does not exist: ${filePath}`)
    content = readFileSync(filePath, 'utf8')
  }
  if (content === undefined || content === '') return {}
  const parsed = parseJson(content, label)
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`)
  return parsed
}

export function applySelection(platformConfig, selection, config) {
  const clone = JSON.parse(JSON.stringify(platformConfig))
  for (const [key, image] of Object.entries(validateSelection(selection, config))) {
    getComponentImageTarget(clone, key, config.components).image = image
  }
  return clone
}

function displayVersion(image) {
  if (image.includes('@')) return image.slice(image.indexOf('@') + 1)
  const name = image.split('/').at(-1)
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : image
}

export function generateActionsMatrix(combinations, config, batchId) {
  if (combinations.length === 0 || combinations.length > 256) {
    throw new Error('GitHub Actions requires 1 to 256 matrix combinations.')
  }
  const keys = [...new Set(combinations.flatMap((selection) => Object.keys(selection)))]
  const varyingKeys = keys.filter((key) => new Set(combinations.map((selection) => selection[key])).size > 1)
  const labelKeys = varyingKeys.length ? varyingKeys : keys
  return {
    include: combinations.map((selection, index) => {
      const runId = `${batchId}-${String(index + 1).padStart(3, '0')}`
      const labels = labelKeys
        .filter((key) => selection[key])
        .map((key) => `${key}=${displayVersion(selection[key])}`)
        .join(', ')
      return {
        runId,
        name: `${runId}${labels ? ` [${labels}]` : ''}`.slice(0, 255),
        testImage: config.test.image,
        selectionBase64: Buffer.from(JSON.stringify(selection)).toString('base64'),
      }
    }),
  }
}
