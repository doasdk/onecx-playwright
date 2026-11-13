import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { applySelection, getComponentImageTarget, runtimeJson, validateSelection } from './matrix.mjs'
import { executeImage } from './execute-image.mjs'
import { executionFailureStage } from './image-execution-contract.mjs'

const packageRequire = createRequire(import.meta.url)

export function dockerCli(args, timeout = 600_000) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    }).trim()
  } catch (error) {
    throw new Error(`Docker ${args[0]} failed. Check Docker access and image registry permissions.`, { cause: error })
  }
}

function platformConfigForRun(config, selection, images) {
  const platformConfig = applySelection(config.platformConfig, selection, config)
  for (const [key, image] of Object.entries(images)) {
    if (key === 'e2e') continue
    getComponentImageTarget(platformConfig, key, config.components).image = image.resolved
  }
  const e2e = platformConfig.container?.e2e
  if (!Array.isArray(e2e) || e2e.length === 0) {
    throw new Error('Platform configuration must define at least one container.e2e networkAlias.')
  }
  e2e[0].image = images.e2e.resolved
  e2e[0].timeoutMs = config.test.timeoutMs
  return platformConfig
}

export function resolveRelativePlatformPaths(platformConfig, platformPath) {
  const config = platformConfig.config
  if (!config) return
  for (const key of ['importsPath', 'realmPath']) {
    if (typeof config[key] === 'string' && !isAbsolute(config[key])) {
      config[key] = resolve(dirname(platformPath), config[key])
    }
  }
}

export function resolveImage(image, env, docker = dockerCli) {
  const isCI = env.CI === 'true' || env.CI === '1'
  if (!(image.endsWith(':local') && !isCI)) docker(['pull', image])
  const inspected = JSON.parse(docker(['image', 'inspect', image]))
  if (!Array.isArray(inspected) || !inspected[0]?.Id) throw new Error(`Docker did not inspect configured image ${image}.`)
  const details = inspected[0]
  return {
    requested: image,
    resolved: image.includes('@sha256:') ? image : details.RepoDigests?.[0] || image,
    imageId: details.Id,
  }
}

export function safeRunId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error('RUN_ID must contain only letters, numbers, underscores, and hyphens.')
  }
  return value
}

function safeSummary(summary) {
  const records = (summary.e2eExecutions || []).map((record) => ({
    networkAlias: record.networkAlias,
    sequence: record.sequence,
    total: record.total,
    status: record.status,
    success: record.success,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
  }))
  const succeeded = records.filter((record) => record.success).length
  return {
    runId: summary.runId,
    status: summary.status,
    exitCode: summary.exitCode,
    startTime: summary.startTime,
    endTime: summary.endTime,
    durationMs: summary.durationMs,
    failureStage: summary.failureStage,
    interruptedBy: summary.interruptedBy,
    testStatus: summary.testStatus,
    allureReportStatus: summary.allureReportStatus,
    imageStatus: summary.imageStatus,
    mode: 'e2e',
    e2eExecutions: records,
    e2eAggregate: {
      total: records.length,
      succeeded,
      failed: records.length - succeeded,
      finalStatus: records.length > 0 && records.every((record) => record.success) ? 'success' : 'failure',
    },
  }
}

function findImporter(containers, alias) {
  for (const container of containers) {
    const networks = Object.values(container.NetworkSettings?.Networks || {})
    if (networks.some((network) => network.Aliases?.includes(alias))) return container
  }
  return undefined
}

export function verifyPlatformImages(manager, images, components, docker) {
  const containers = manager.getAllContainers()
  for (const [key, image] of Object.entries(images)) {
    if (key === 'e2e' || key === 'core.importmanager') continue
    const alias = components[key]
    const container = containers.get(alias)
    if (!container) {
      image.status = 'verification-failed'
      throw new Error(`Platform did not start configured component ${key} (${alias}).`)
    }
    const actualImage = docker(['inspect', '--format', '{{.Image}}', container.getId()])
    if (actualImage !== image.imageId) {
      image.status = 'verification-failed'
      image.actualImageId = actualImage
      throw new Error(`Platform started an unexpected image for ${key}.`)
    }
    image.verified = true
    image.status = 'verified'
  }
}

export function verifyImporter(config, images, components) {
  if (!config.platformConfig.importData) return
  const alias = components['core.importmanager']
  if (!alias || !images['core.importmanager']) {
    throw new Error('components must map core.importmanager to verify configured data imports.')
  }
  images['core.importmanager'].status = 'verification-pending'
  return { alias, expected: images['core.importmanager'] }
}

export async function verifyImportResult(metadata, importer, docker) {
  if (!importer) return
  if (!metadata?.network?.id) throw new Error('Platform network ID is unavailable for import verification.')
  const ids = docker(['ps', '-aq', '--filter', `network=${metadata.network.id}`]).split(/\s+/).filter(Boolean)
  if (ids.length === 0) {
    importer.expected.status = 'verification-failed'
    throw new Error(`Data importer ${importer.alias} was not created.`)
  }
  const inspected = JSON.parse(docker(['inspect', ...ids]))
  const found = findImporter(inspected, importer.alias)
  if (!found) {
    importer.expected.status = 'verification-failed'
    throw new Error(`Data importer ${importer.alias} was not found on the platform network.`)
  }
  const status = docker(['wait', found.Id], 120_000)
  if (status !== '0') {
    importer.expected.status = 'verification-failed'
    throw new Error(`Data import failed with exit code ${status}.`)
  }
  const actual = JSON.parse(docker(['inspect', '--format', '{{json .State}}', found.Id]))
  if (actual.Status !== 'exited' || actual.ExitCode !== 0) {
    importer.expected.status = 'verification-failed'
    throw new Error(`Data import ended in unexpected state ${actual.Status} (exit ${actual.ExitCode}).`)
  }
  if (found.Image !== importer.expected.imageId) {
    importer.expected.status = 'verification-failed'
    throw new Error('Platform started an unexpected data importer image.')
  }
  importer.expected.verified = true
  importer.expected.status = 'verified'
}

function copyReportResults(source, target) {
  if (existsSync(source)) cpSync(source, target, { recursive: true })
}

function generateRunReport(resultsDir, reportDir) {
  const allureResults = join(resultsDir, 'allure-results')
  if (!existsSync(allureResults)) return false
  const allureEntry = packageRequire.resolve('allure-commandline')
  const allureBin = join(dirname(allureEntry), 'bin', 'allure')
  const result = spawnSync(process.execPath, [allureBin, 'generate', allureResults, '--clean', '-o', reportDir], {
    stdio: 'inherit',
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Allure report generation failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`)
  }
  return true
}

export function imageStatus(images) {
  const entries = Object.entries(images)
  const verified = entries.filter(([, image]) => image.status === 'verified').length
  const failed = entries.filter(([, image]) => ['resolution-failed', 'verification-failed'].includes(image.status)).length
  return {
    status: failed ? 'failure' : entries.length > 0 && verified === entries.length ? 'verified' : 'incomplete',
    total: entries.length,
    verified,
    failed,
    images: Object.fromEntries(entries.map(([name, image]) => [name, image.status])),
  }
}

export async function runSingle(config, options = {}) {
  const env = options.env || process.env
  const docker = options.docker || dockerCli
  const resolveConfiguredImage = options.resolveImage || ((image) => resolveImage(image, env, docker))
  const execute = options.executeImage || executeImage
  const generateReport = options.generateRunReport || generateRunReport
  const runId = safeRunId(options.runId || env.RUN_ID || `run-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`)
  const resultsRoot = resolve(options.results || join(process.cwd(), 'results'))
  const workRoot = resolve(options.work || join(process.cwd(), 'integration-tests'))
  const resultsDir = join(resultsRoot, runId)
  const workDir = join(workRoot, runId)
  if (existsSync(resultsDir) || existsSync(workDir)) {
    throw new Error(`Run output already exists for ${runId}; choose a new RUN_ID.`)
  }

  const started = new Date()
  const summary = {
    runId,
    startTime: started.toISOString(),
    status: 'failure',
    exitCode: 1,
    testStatus: 'not-run',
    allureReportStatus: 'not-generated',
  }
  const provenance = {
    runId,
    runnerVersion: JSON.parse(
      readFileSync(join(dirname(packageRequire.resolve('@onecx/integration-tests')), 'package.json'), 'utf8')
    ).version,
    images: {},
  }
  const secretDir = mkdtempSync(join(tmpdir(), 'onecx-it-'))
  const configDir = mkdtempSync(join(tmpdir(), 'onecx-it-platform-'))
  let manager
  let containerName
  let interruptedBy
  let reportFailure
  let stage = 'configuration'
  const originals = new Map()
  const setEnv = (name, value) => {
    originals.set(name, env[name])
    env[name] = value
  }
  const interrupt = (signal) => {
    interruptedBy = signal
    if (containerName) {
      try {
        docker(['kill', '--signal', signal, containerName])
      } catch {
        console.error(`Unable to forward ${signal} to the E2E container.`)
      }
    }
  }
  const sigint = () => interrupt('SIGINT')
  const sigterm = () => interrupt('SIGTERM')

  mkdirSync(resultsRoot, { recursive: true })
  mkdirSync(workRoot, { recursive: true })
  mkdirSync(resultsDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)

  try {
    const selection = validateSelection(options.selection || {}, config)
    const environments = runtimeJson(
      env.ENVIRONMENTS_JSON,
      env.ENVIRONMENTS_JSON_FILE,
      'ENVIRONMENTS_JSON',
      config.configDirectory
    )
    const data = runtimeJson(env.TEST_DATA_JSON, env.TEST_DATA_JSON_FILE, 'TEST_DATA_JSON', config.configDirectory)
    const platformConfig = applySelection(config.platformConfig, selection, config)
    const images = {}
    stage = 'image-resolution'
    for (const [key, alias] of Object.entries(config.components)) {
      if (key === 'core.importmanager' && !platformConfig.importData) continue
      const override = getComponentImageTarget(platformConfig, key, config.components)
      if (typeof override.image !== 'string') {
        throw new Error(`Platform component ${key} requires an explicit image for verification.`)
      }
      let image
      try {
        image = resolveConfiguredImage(override.image)
      } catch (error) {
        provenance.images[key] = { requested: override.image, status: 'resolution-failed' }
        throw error
      }
      image.status = 'resolved'
      images[key] = image
      provenance.images[key] = image
      override.image = image.resolved
      if (typeof alias !== 'string') throw new Error(`Missing container alias for ${key}.`)
    }
    try {
      images.e2e = resolveConfiguredImage(config.test.image)
      images.e2e.status = 'resolved'
    } catch (error) {
      provenance.images.e2e = { requested: config.test.image, status: 'resolution-failed' }
      throw error
    }
    provenance.images.e2e = images.e2e
    const resolvedConfig = platformConfigForRun(config, selection, images)
    resolveRelativePlatformPaths(resolvedConfig, config.platformPath)
    const e2eConfig = resolvedConfig.container.e2e[0]
    if (!e2eConfig?.networkAlias) throw new Error('Platform configuration e2e[0].networkAlias is required.')

    const platformConfigFile = join(configDir, 'platform.json')
    writeFileSync(platformConfigFile, JSON.stringify({ platformConfig: resolvedConfig }), { mode: 0o600 })
    setEnv('RUN_ID', runId)
    setEnv('E2E_RUN_ID', runId)
    setEnv('ARTIFACTS_ROOT', workRoot)
    setEnv('E2E_BASE_DIR', workDir)

    const { PlatformManager } = options.platform || packageRequire('@onecx/integration-tests')
    manager = new PlatformManager(
      platformConfigFile,
      config.artifacts.capturePrivate
        ? (name) => {
            const logDir = join(workDir, 'logs')
            mkdirSync(logDir, { recursive: true })
            return join(logDir, `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.log`)
          }
        : undefined
    )
    if (!manager.hasValidatedConfig()) throw new Error('Platform schema validation failed.')
    if (options.dryRun) {
      summary.status = 'success'
      summary.exitCode = 0
    } else {
      stage = 'image-resolution'
      docker(['info'])
      stage = 'platform-startup'
      await manager.startContainers()
      if (interruptedBy) throw new Error('Run interrupted during platform startup.')

      stage = 'image-verification'
      const metadata = await manager.getPlatformInfo()
      if ((!metadata?.e2e?.baseUrl && !config.test.baseUrl) || !metadata?.network?.id) {
        throw new Error('Platform must export a network ID and either an E2E URL or test.baseUrl must be configured.')
      }
      verifyPlatformImages(manager, images, config.components, docker)
      const importer = verifyImporter(config, images, config.components)
      await manager.exportPlatformInfo()
      await manager.checkAllHealthy()
      await verifyImportResult(metadata, importer, docker)
      if (interruptedBy) throw new Error(`Run interrupted by ${interruptedBy}.`)

      stage = 'e2e'
      const testMetadata = {
        ...metadata,
        e2e: {
          ...metadata.e2e,
          baseUrl: config.test.baseUrl || metadata.e2e.baseUrl,
        },
      }
      summary.e2eExecutions = await execute({
        image: images.e2e.resolved,
        metadata: testMetadata,
        expectedImageId: images.e2e.imageId,
        onImageVerified: () => {
          images.e2e.verified = true
          images.e2e.status = 'verified'
        },
        environments,
        data,
        environment: config.environment,
        script: config.test.script,
        capture: config.artifacts.capturePrivate,
        secretDir,
        runDir: workDir,
        alias: e2eConfig.networkAlias,
        timeoutMs: config.test.timeoutMs,
        isInterrupted: () => Boolean(interruptedBy),
        onContainer: (name) => {
          containerName = name
        },
      })
      const testsPassed =
        summary.e2eExecutions.length > 0 && summary.e2eExecutions.every((record) => record.success)
      if (!testsPassed) {
        summary.failureStage = executionFailureStage(summary.e2eExecutions)
        summary.testStatus = 'failure'
      } else {
        summary.status = 'success'
        summary.exitCode = 0
        summary.testStatus = 'success'
      }
      copyReportResults(
        join(workDir, 'e2e-results', e2eConfig.networkAlias, 'allure-results'),
        join(resultsDir, 'allure-results')
      )
      copyReportResults(
        join(workDir, 'e2e-results', e2eConfig.networkAlias, 'execution.json'),
        join(resultsDir, 'execution.json')
      )
      try {
        summary.allureReportStatus = generateReport(resultsDir, join(resultsDir, 'allure-report'))
          ? 'success'
          : 'not-generated'
      } catch (error) {
        reportFailure = error
        summary.allureReportStatus = 'failure'
      }
    }
  } catch (error) {
    if (stage === 'e2e') summary.testStatus = 'failure'
    summary.status = 'failure'
    summary.exitCode = 1
    summary.failureStage = stage
    console.error(`Integration run failed during ${stage}.`, error instanceof Error ? error.message : String(error))
  } finally {
    if (manager) {
      try {
        await manager.stopAllContainers()
      } catch (error) {
        summary.status = 'failure'
        summary.exitCode = 1
        summary.failureStage = 'cleanup'
        console.error('Platform cleanup failed.', error instanceof Error ? error.message : String(error))
      }
    }
    if (reportFailure) {
      summary.status = 'failure'
      summary.exitCode = 1
      summary.failureStage = 'report'
      console.error(reportFailure instanceof Error ? reportFailure.message : String(reportFailure))
    }
    if (interruptedBy) {
      summary.status = 'failure'
      summary.exitCode = interruptedBy === 'SIGINT' ? 130 : 143
      summary.failureStage = 'interrupted'
      summary.interruptedBy = interruptedBy
    }
    if (config.artifacts.capturePrivate && existsSync(workDir)) {
      const privateDir = join(resultsDir, 'private')
      mkdirSync(privateDir, { recursive: true, mode: 0o700 })
      cpSync(workDir, privateDir, { recursive: true })
    }
    summary.endTime = new Date().toISOString()
    summary.durationMs = Date.now() - started.getTime()
    summary.imageStatus = imageStatus(provenance.images)
    if (summary.status !== 'success' && !summary.failureStage) summary.failureStage = stage
    const safe = safeSummary(summary)
    writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(safe, null, 2))
    writeFileSync(join(resultsDir, 'versions.json'), JSON.stringify(provenance, null, 2))
    writeFileSync(join(workDir, 'summary.json'), JSON.stringify(safe, null, 2))
    const e2eDir = join(workDir, 'e2e')
    mkdirSync(e2eDir, { recursive: true })
    writeFileSync(
      join(e2eDir, 'e2e-executions.json'),
      JSON.stringify({ records: safe.e2eExecutions, aggregate: safe.e2eAggregate }, null, 2)
    )
    rmSync(secretDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)
    for (const [name, value] of originals) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
  }
  return summary
}

export async function runMatrix(config, combinations, options = {}) {
  const batchId = `matrix-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
  const resultsRoot = resolve(options.results || join(process.cwd(), 'results'))
  const matrix = options.matrix || { include: combinations.map((selection, index) => ({
    runId: `${batchId}-${String(index + 1).padStart(3, '0')}`,
    selectionBase64: Buffer.from(JSON.stringify(selection)).toString('base64'),
  })) }
  const reportIndex = matrix.include.map(({ runId, selectionBase64 }) => ({
    runId,
    selection: JSON.parse(Buffer.from(selectionBase64, 'base64').toString('utf8')),
  }))
  mkdirSync(resultsRoot, { recursive: true })
  const indexFile = options.indexFile || process.env.ONECX_MATRIX_INDEX_FILE
    ? resolve(options.indexFile || process.env.ONECX_MATRIX_INDEX_FILE)
    : join(resultsRoot, 'matrix-index-input.json')
  mkdirSync(dirname(indexFile), { recursive: true })
  writeFileSync(indexFile, JSON.stringify(reportIndex, null, 2))

  const results = []
  for (const entry of matrix.include) {
    const selection = JSON.parse(Buffer.from(entry.selectionBase64, 'base64').toString('utf8'))
    const result = await runSingle(config, { ...options, runId: entry.runId, selection })
    results.push({ runId: entry.runId, selection, status: result.status, exitCode: result.exitCode })
    if (result.exitCode === 130 || result.exitCode === 143) break
  }
  const summaryDir = join(resultsRoot, batchId)
  mkdirSync(summaryDir, { recursive: true })
  writeFileSync(join(summaryDir, 'matrix-summary.json'), JSON.stringify({ results }, null, 2))
  return { batchId, results, indexFile }
}
