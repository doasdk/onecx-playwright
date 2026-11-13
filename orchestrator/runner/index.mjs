#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  decodeSelection,
  expandMatrix,
  generateActionsMatrix,
  loadConfig,
  parseJson,
  validateSelection,
} from './matrix.mjs'
import { collectReport } from './report.mjs'
import { runMatrix, runSingle } from './run.mjs'
import { servePlatform } from './serve.mjs'

const USAGE = `Usage: onecx-it <validate|matrix|run|run-matrix|report|serve> --config <path> [options]

Options:
  --config <path>       Orchestrator JSON configuration
  --selection <base64>  Matrix selection (run/serve; or MATRIX_SELECTION_BASE64)
  --selection-file <path>  JSON matrix selection (run/serve)
  --results <path>      Results directory (default: ./results)
  --work <path>         Work directory (default: ./integration-tests)
  -h, --help            Show help`

function parseArgs(argv) {
  const [command, ...args] = argv
  if (command === '--help' || command === '-h' || command === undefined) {
    return { help: true }
  }
  if (!['validate', 'matrix', 'run', 'run-matrix', 'report', 'serve'].includes(command)) {
    throw new Error(`Unknown command: ${command}`)
  }
  const options = { command }
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--help' || name === '-h') return { help: true }
    if (!['--config', '--selection', '--selection-file', '--results', '--work'].includes(name)) {
      throw new Error(`Unknown option: ${name}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
    const key = name.slice(2)
    if (options[key] !== undefined) throw new Error(`${name} may be specified only once.`)
    options[key] = value
    index += 1
  }
  if (!options.config) throw new Error('Specify --config <path>.')
  if (options.selection !== undefined && command !== 'run' && command !== 'serve') {
    throw new Error('--selection is supported only with the run and serve commands.')
  }
  if (options['selection-file'] !== undefined && command !== 'run' && command !== 'serve') {
    throw new Error('--selection-file is supported only with the run and serve commands.')
  }
  if (options.selection !== undefined && options['selection-file'] !== undefined) {
    throw new Error('Specify only one of --selection and --selection-file.')
  }
  return options
}

function selectedComponents(options, config) {
  const file = options['selection-file']
  if (file) {
    const selectionPath = resolve(file)
    const selection = parseJson(readFileSync(selectionPath, 'utf8'), 'Matrix selection file')
    return validateSelection(selection, config)
  }
  const encoded = options.selection ?? process.env.MATRIX_SELECTION_BASE64 ?? ''
  return decodeSelection(encoded, config)
}

function resultPaths(options) {
  return {
    results: resolve(options.results || join(process.cwd(), 'results')),
    work: resolve(options.work || join(process.cwd(), 'integration-tests')),
  }
}

function writeMatrixIndex(matrix, resultsRoot) {
  const entries = matrix.include.map(({ runId, selectionBase64 }) => ({
    runId,
    selection: parseJson(Buffer.from(selectionBase64, 'base64').toString('utf8'), 'Matrix selection'),
  }))
  const target = process.env.ONECX_MATRIX_INDEX_FILE
    ? resolve(process.env.ONECX_MATRIX_INDEX_FILE)
    : join(resultsRoot, 'matrix-index-input.json')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(entries, null, 2))
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const config = loadConfig(options.config, process.env)
  const paths = resultPaths(options)
  if (options.command === 'validate') {
    console.log(`Configuration valid: ${config.configPath}`)
    return 0
  }
  if (options.command === 'matrix') {
    const combinations = expandMatrix(config.matrix, config)
    const batch = `matrix-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
    const matrix = generateActionsMatrix(combinations, config, batch)
    writeMatrixIndex(matrix, paths.results)
    process.stdout.write(`${JSON.stringify(matrix)}\n`)
    return 0
  }
  if (options.command === 'run') {
    const selection = selectedComponents(options, config)
    const summary = await runSingle(config, { ...paths, selection })
    return summary.exitCode
  }
  if (options.command === 'serve') {
    const selection = selectedComponents(options, config)
    const summary = await servePlatform(config, { ...paths, selection })
    return summary.exitCode
  }
  if (options.command === 'run-matrix') {
    const combinations = expandMatrix(config.matrix, config)
    const batch = `matrix-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
    const matrix = generateActionsMatrix(combinations, config, batch)
    const result = await runMatrix(config, combinations, { ...paths, matrix })
    console.log(`Matrix runs complete. Report index: ${result.indexFile}`)
    return result.results.some(({ exitCode }) => exitCode !== 0) ? 1 : 0
  }
  if (options.command === 'report') {
    const indexFile = process.env.ONECX_MATRIX_INDEX_FILE
      ? resolve(process.env.ONECX_MATRIX_INDEX_FILE)
      : join(paths.results, 'matrix-index-input.json')
    const result = collectReport({ resultsRoot: paths.results, workDir: paths.work, indexFile })
    console.log(`Matrix report index: ${result.indexPath}`)
    if (result.combined) console.log(`Combined Allure report: ${join(paths.results, 'combined-allure-report')}`)
    return result.missing || result.failed ? 1 : 0
  }
  throw new Error(`Unsupported command ${options.command}`)
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
)
