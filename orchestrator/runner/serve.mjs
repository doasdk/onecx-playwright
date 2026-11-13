import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  applySelection,
  getComponentImageTarget,
  validateSelection,
} from './matrix.mjs'
import {
  dockerCli,
  imageStatus,
  resolveImage,
  resolveRelativePlatformPaths,
  safeRunId,
  verifyImportResult,
  verifyImporter,
  verifyPlatformImages,
} from './run.mjs'

const packageRequire = createRequire(import.meta.url)

function platformConfigForServe(config, selection, images) {
  const platformConfig = applySelection(config.platformConfig, selection, config)
  for (const [key, image] of Object.entries(images)) {
    getComponentImageTarget(platformConfig, key, config.components).image = image.resolved
  }
  return platformConfig
}

function waitForSignal() {
  return new Promise((resolveSignal) => {
    const cleanup = () => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
    }
    const onInterrupt = () => {
      cleanup()
      resolveSignal('SIGINT')
    }
    const onTerminate = () => {
      cleanup()
      resolveSignal('SIGTERM')
    }
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
  })
}

export async function servePlatform(config, options = {}) {
  const env = options.env || process.env
  const docker = options.docker || dockerCli
  const resolveConfiguredImage = options.resolveImage || ((image) => resolveImage(image, env, docker))
  const awaitSignal = options.waitForSignal || waitForSignal
  const runId = safeRunId(
    options.runId || env.RUN_ID || `serve-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
  )
  const resultsRoot = resolve(options.results || join(process.cwd(), 'results'))
  const workRoot = resolve(options.work || join(process.cwd(), 'integration-tests'))
  const resultsDir = join(resultsRoot, runId)
  const workDir = join(workRoot, runId)
  if (existsSync(resultsDir) || existsSync(workDir)) {
    throw new Error(`Run output already exists for ${runId}; choose a new RUN_ID.`)
  }

  const started = new Date()
  const summary = { runId, mode: 'platform-only', status: 'failure', exitCode: 1 }
  const provenance = {
    runId,
    runnerVersion: JSON.parse(
      readFileSync(join(dirname(packageRequire.resolve('@onecx/integration-tests')), 'package.json'), 'utf8')
    ).version,
    images: {},
  }
  const configDir = mkdtempSync(join(tmpdir(), 'onecx-it-platform-'))
  const originals = new Map()
  const setEnv = (name, value) => {
    originals.set(name, env[name])
    env[name] = value
  }
  let manager
  let interruptedBy
  let stage = 'configuration'
  mkdirSync(resultsDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })

  try {
    const selection = validateSelection(options.selection || {}, config)
    const images = {}
    const selectedConfig = applySelection(config.platformConfig, selection, config)
    stage = 'image-resolution'
    for (const key of Object.keys(config.components)) {
      if (key === 'core.importmanager' && !selectedConfig.importData) continue
      const target = getComponentImageTarget(selectedConfig, key, config.components)
      let image
      try {
        image = resolveConfiguredImage(target.image)
      } catch (error) {
        provenance.images[key] = { requested: target.image, status: 'resolution-failed' }
        throw error
      }
      image.status = 'resolved'
      images[key] = image
      provenance.images[key] = image
    }

    const platformConfig = platformConfigForServe(config, selection, images)
    resolveRelativePlatformPaths(platformConfig, config.platformPath)
    const platformConfigFile = join(configDir, 'platform.json')
    writeFileSync(platformConfigFile, JSON.stringify({ platformConfig }), { mode: 0o600 })
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

    stage = 'platform-startup'
    docker(['info'])
    await manager.startContainers()
    stage = 'image-verification'
    const metadata = await manager.getPlatformInfo()
    if (!metadata?.network?.id) throw new Error('Platform did not export a network ID.')
    verifyPlatformImages(manager, images, config.components, docker)
    const importer = verifyImporter(config, images, config.components)
    await manager.exportPlatformInfo()
    await manager.checkAllHealthy()
    await verifyImportResult(metadata, importer, docker)
    summary.status = 'success'
    summary.exitCode = 0
    console.log(`Platform ready (run ${runId}).`)
    for (const [name, url] of Object.entries(metadata.external || {})) {
      if (url) console.log(`${name}: ${url}`)
    }
    console.log('Press Ctrl+C to stop the platform.')
    interruptedBy = await awaitSignal()
  } catch (error) {
    summary.failureStage = stage
    console.error(`Platform serve failed during ${stage}.`, error instanceof Error ? error.message : String(error))
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
    if (interruptedBy) {
      summary.status = 'interrupted'
      summary.interruptedBy = interruptedBy
      summary.exitCode = interruptedBy === 'SIGINT' ? 130 : 143
    }
    if (config.artifacts.capturePrivate && existsSync(workDir)) {
      const privateDir = join(resultsDir, 'private')
      mkdirSync(privateDir, { recursive: true, mode: 0o700 })
      cpSync(workDir, privateDir, { recursive: true })
    }
    summary.endTime = new Date().toISOString()
    summary.durationMs = Date.now() - started.getTime()
    summary.imageStatus = imageStatus(provenance.images)
    writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2))
    writeFileSync(join(resultsDir, 'versions.json'), JSON.stringify(provenance, null, 2))
    rmSync(configDir, { recursive: true, force: true })
    for (const [name, value] of originals) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
  }

  return summary
}
