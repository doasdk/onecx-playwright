import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReportIndex, collectReport, mergeAllureResults } from './report.mjs'

test('should index successful and missing matrix execution results', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'onecx-it-report-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'present'))
  writeFileSync(join(root, 'present', 'summary.json'), JSON.stringify({ status: 'failure', failureStage: 'e2e' }))
  const result = buildReportIndex(root, [
    { runId: 'present', selection: { 'core.database': 'registry/db:1' } },
    { runId: 'missing', selection: {} },
  ])
  assert.equal(result.missing, true)
  assert.equal(result.failed, true)
  assert.deepEqual(result.index, [
    {
      runId: 'present',
      selection: { 'core.database': 'registry/db:1' },
      status: 'failure',
      failureStage: 'e2e',
      summary: 'present/summary.json',
      report: null,
    },
    { runId: 'missing', selection: {}, status: 'missing-artifacts' },
  ])
})

test('should merge Allure results and attach component provenance', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'onecx-it-allure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const run = join(root, 'run-one')
  mkdirSync(join(run, 'allure-results'), { recursive: true })
  writeFileSync(
    join(run, 'allure-results', 'case-result.json'),
    JSON.stringify({
      labels: [{ name: 'parentSuite', value: 'chromium' }, { name: 'suite', value: 'tests.ts' }],
      parameters: [{ name: 'Project', value: 'chromium' }],
      historyId: 'original',
    })
  )
  writeFileSync(
    join(run, 'versions.json'),
    JSON.stringify({ images: { 'services.catalog': { requested: 'registry.example/catalog:1' } } })
  )
  const target = join(root, 'merged')
  mkdirSync(target)
  writeFileSync(join(target, 'stale.json'), '{}')
  assert.equal(mergeAllureResults(root, ['run-one'], target), true)
  const result = JSON.parse(readFileSync(join(target, 'case-result.json'), 'utf8'))
  assert.deepEqual(result.labels, [
    { name: 'parentSuite', value: 'integration-job-0001' },
    { name: 'suite', value: 'chromium' },
  ])
  assert.match(result.description, /services.catalog/)
  assert.equal(result.historyId, 'run-one:original')
  assert.equal(existsSync(join(target, 'stale.json')), false)
})

test('should write the matrix report index without requiring Allure results', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'onecx-it-collect-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const results = join(root, 'results')
  mkdirSync(join(results, 'run-one'), { recursive: true })
  writeFileSync(join(results, 'run-one', 'summary.json'), JSON.stringify({ status: 'success' }))
  const indexInput = join(root, 'matrix-index-input.json')
  writeFileSync(indexInput, JSON.stringify([{ runId: 'run-one', selection: {} }]))
  const report = collectReport({
    resultsRoot: results,
    workDir: join(root, 'work'),
    indexFile: indexInput,
  })
  assert.equal(report.combined, false)
  assert.equal(report.missing, false)
  assert.equal(JSON.parse(readFileSync(join(results, 'matrix-index.json'), 'utf8'))[0].status, 'success')
})

test('should reject unsafe run IDs in a report index', () => {
  assert.throws(() => buildReportIndex('.', [{ runId: '..\\outside' }]), /safe runId/)
})
