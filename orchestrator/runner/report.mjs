import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { isRecord, parseJson } from './matrix.mjs'

const packageRequire = createRequire(import.meta.url)

function readVersions(resultsRoot, runId) {
  const file = join(resultsRoot, runId, 'versions.json')
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8')
}

export function mergeAllureResults(resultsRoot, runIds, target) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  let count = 0
  for (const [index, runId] of runIds.entries()) {
    const source = join(resultsRoot, runId, 'allure-results')
    if (!existsSync(source)) continue
    cpSync(source, target, { recursive: true })
    const versionText = readVersions(resultsRoot, runId)
    const job = `integration-job-${String(index + 1).padStart(4, '0')}`
    const versions = versionText ? parseJson(versionText, `${runId} versions`) : undefined
    const componentVersions = versions
      ? Object.fromEntries(Object.entries(versions.images || {}).map(([key, image]) => [key, image.requested]))
      : undefined
    const notes = componentVersions
      ? `Component versions:\n\`\`\`json\n${JSON.stringify(componentVersions, null, 2)}\n\`\`\``
      : 'Component versions: unavailable (versions.json is missing).'
    const attachment = `${job}-versions.json`
    if (versionText) writeFileSync(join(target, attachment), versionText)

    for (const file of readdirSync(source).filter((name) => name.endsWith('-result.json'))) {
      const filePath = join(target, file)
      const result = parseJson(readFileSync(filePath, 'utf8'), `Allure result ${runId}/${file}`)
      const labels = result.labels || []
      const suite = result.parameters?.find(({ name }) => name === 'Project')?.value ||
        labels.find(({ name }) => name === 'parentSuite')?.value
      if (!suite) throw new Error(`Missing Playwright project label for ${runId}/${file}.`)
      result.labels = [
        ...labels.filter(({ name }) => !['parentSuite', 'suite', 'subSuite'].includes(name)),
        { name: 'parentSuite', value: job },
        { name: 'suite', value: suite },
      ]
      result.description = [result.description, notes].filter(Boolean).join('\n\n')
      if (result.descriptionHtml) {
        const escaped = notes.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        result.descriptionHtml += `<pre>${escaped}</pre>`
      }
      if (versionText) {
        result.attachments = [
          ...(result.attachments || []),
          { name: 'versions.json', source: attachment, type: 'application/json' },
        ]
      }
      for (const key of ['historyId', 'testCaseId']) {
        if (result[key]) result[key] = `${runId}:${result[key]}`
      }
      writeFileSync(filePath, JSON.stringify(result))
      count += 1
    }
  }
  return count > 0
}

export function generateCombinedReport(resultsRoot, runIds, workDir, reportDir, launch = spawnSync) {
  const combinedResults = join(workDir, 'combined-allure-results')
  if (!mergeAllureResults(resultsRoot, runIds, combinedResults)) return false
  const allureEntry = packageRequire.resolve('allure-commandline')
  const allureBin = join(dirname(allureEntry), 'bin', 'allure')
  const result = launch(process.execPath, [allureBin, 'generate', combinedResults, '--clean', '-o', reportDir], {
    stdio: 'inherit',
  })
  if (result.error || result.status !== 0) throw new Error('Combined Allure report generation failed.')
  return true
}

export function buildReportIndex(resultsRoot, entries) {
  if (!Array.isArray(entries)) throw new Error('Matrix report index must be a JSON array.')
  let missing = false
  let failed = false
  const index = entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.runId)) {
      throw new Error('Matrix report index entries require a safe runId.')
    }
    const summaryPath = join(resultsRoot, entry.runId, 'summary.json')
    if (!existsSync(summaryPath)) {
      missing = true
      return { runId: entry.runId, selection: entry.selection, status: 'missing-artifacts' }
    }
    const summary = parseJson(readFileSync(summaryPath, 'utf8'), `${entry.runId} summary`)
    if (summary.status !== 'success') failed = true
    return {
      runId: entry.runId,
      selection: entry.selection,
      status: summary.status,
      failureStage: summary.failureStage,
      summary: `${entry.runId}/summary.json`,
      report: existsSync(join(resultsRoot, entry.runId, 'allure-report', 'index.html'))
        ? `${entry.runId}/allure-report/index.html`
        : null,
    }
  })
  return { index, missing, failed }
}

export function collectReport({ resultsRoot, workDir, indexFile, outputFile }) {
  const absoluteIndexFile = resolve(indexFile)
  const entries = parseJson(readFileSync(absoluteIndexFile, 'utf8'), 'Matrix report index')
  const { index, missing, failed } = buildReportIndex(resolve(resultsRoot), entries)
  mkdirSync(resolve(resultsRoot), { recursive: true })
  const indexPath = outputFile || join(resolve(resultsRoot), 'matrix-index.json')
  writeFileSync(indexPath, JSON.stringify(index, null, 2))
  const runIds = entries.map((entry) => entry.runId)
  const combined = generateCombinedReport(
    resolve(resultsRoot),
    runIds,
    resolve(workDir),
    join(resolve(resultsRoot), 'combined-allure-report')
  )
  return { index, indexPath, missing, failed, combined }
}
