import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import {
  expandMatrix,
  applySelection,
  generateActionsMatrix,
  loadConfig,
  runtimeJson,
  validateSelection,
} from './matrix.mjs'

function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'onecx-it-config-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const platform = {
    platformConfig: {
      importData: false,
      platformOverrides: {
        core: { postgres: { image: 'registry.example/postgres:16' } },
        services: { catalog: { image: 'registry.example/catalog:1' } },
      },
      container: { e2e: [{ networkAlias: 'catalog-e2e' }] },
    },
  }
  writeFileSync(join(root, 'platform.json'), JSON.stringify(platform))
  const config = {
    schemaVersion: 1,
    platform: { config: 'platform.json' },
    test: { image: 'registry.example/tests:1' },
    matrix: { 'services.catalog': ['registry.example/catalog:1', 'registry.example/catalog:2'] },
    components: { 'core.postgres': 'postgresdb', 'services.catalog': 'catalog-svc' },
    ...changes,
  }
  const configPath = join(root, 'onecx-it.json')
  writeFileSync(configPath, JSON.stringify(config))
  return { root, configPath, config }
}

test('should load a generic application config without Workspace test-user settings', (t) => {
  const { configPath } = fixture(t)
  const config = loadConfig(configPath, {})
  assert.equal(config.test.script, 'tests:gui')
  assert.equal(config.test.timeoutMs, 1_800_000)
  assert.equal(config.environment, 'container')
  assert.equal(config.platformConfig.container.e2e[0].networkAlias, 'catalog-e2e')
  assert.equal(config.platformConfig.container.adminShell, undefined)
})

test('should load a matrix JSON file relative to the orchestration config', (t) => {
    const { root, configPath, config: source } = fixture(t)
    const matrix = {
      'services.catalog': ['registry.example/catalog:3', 'registry.example/catalog:4'],
    }
    writeFileSync(join(root, 'versions.json'), JSON.stringify(matrix))
    const config = { ...source, matrix: './versions.json' }
    writeFileSync(configPath, JSON.stringify(config))
    const loaded = loadConfig(configPath, {})
    assert.equal(loaded.matrixPath, join(root, 'versions.json'))
    assert.deepEqual(loaded.matrix, matrix)
    assert.equal(expandMatrix(loaded.matrix, loaded).length, 2)
})

test('should reject a malformed matrix file', (t) => {
    const { root, configPath, config: source } = fixture(t)
    writeFileSync(join(root, 'versions.json'), '{')
    writeFileSync(configPath, JSON.stringify({ ...source, matrix: 'versions.json' }))
    assert.throws(() => loadConfig(configPath, {}), /Version matrix must contain valid JSON/)
})

test('should apply a matrix selection to a declarative extra UI container', (t) => {
    const { root, configPath, config: source } = fixture(t)
    const platform = JSON.parse(readFileSync(join(root, 'platform.json'), 'utf8'))
    delete platform.platformConfig.platformOverrides.services
    platform.platformConfig.container.ui = [
      {
        image: 'registry.example/catalog-ui:1',
        networkAlias: 'catalog-ui',
        uiDetails: { appBaseHref: '/', appId: 'catalog', productName: 'Catalog' },
      },
    ]
    writeFileSync(join(root, 'platform.json'), JSON.stringify(platform))
    const config = {
      ...source,
      matrix: { 'app.catalog': ['registry.example/catalog-ui:1', 'registry.example/catalog-ui:2'] },
      components: { 'app.catalog': 'catalog-ui' },
    }
    writeFileSync(configPath, JSON.stringify(config))
    const loaded = loadConfig(configPath, {})
    const updated = applySelection(loaded.platformConfig, { 'app.catalog': 'registry.example/catalog-ui:2' }, loaded)
    assert.equal(updated.container.ui[0].image, 'registry.example/catalog-ui:2')
})

test('should expand matrix selections as a Cartesian product', (t) => {
  const { configPath } = fixture(t, {
    matrix: {
      'core.postgres': ['registry.example/postgres:16', 'registry.example/postgres:17'],
      'services.catalog': ['registry.example/catalog:1', 'registry.example/catalog:2'],
    },
  })
  const config = loadConfig(configPath, {})
  assert.deepEqual(expandMatrix(config.matrix, config), [
    { 'core.postgres': 'registry.example/postgres:16', 'services.catalog': 'registry.example/catalog:1' },
    { 'core.postgres': 'registry.example/postgres:16', 'services.catalog': 'registry.example/catalog:2' },
    { 'core.postgres': 'registry.example/postgres:17', 'services.catalog': 'registry.example/catalog:1' },
    { 'core.postgres': 'registry.example/postgres:17', 'services.catalog': 'registry.example/catalog:2' },
  ])
})

test('should emit only the agreed matrix entry fields', (t) => {
  const { configPath } = fixture(t)
  const config = loadConfig(configPath, {})
  const generated = generateActionsMatrix(expandMatrix(config.matrix, config), config, 'matrix-test')
  assert.deepEqual(Object.keys(generated), ['include'])
  assert.deepEqual(Object.keys(generated.include[0]), ['runId', 'name', 'testImage', 'selectionBase64'])
  assert.equal(generated.include[0].testImage, 'registry.example/tests:1')
  assert.deepEqual(
    JSON.parse(Buffer.from(generated.include[0].selectionBase64, 'base64').toString('utf8')),
    { 'services.catalog': 'registry.example/catalog:1' }
  )
})

test('should print only JSON and write the report index in matrix CLI mode', (t) => {
  const { root, configPath } = fixture(t)
  const cli = fileURLToPath(new URL('./index.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'matrix', '--config', configPath], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(output), ['include'])
  assert.equal(output.include.length, 2)
  const indexFile = join(root, 'results', 'matrix-index-input.json')
  assert.equal(existsSync(indexFile), true)
  assert.equal(JSON.parse(readFileSync(indexFile, 'utf8')).length, 2)
})

test('should load and validate a JSON selection file for serve', (t) => {
  const { root, configPath } = fixture(t)
  const cli = fileURLToPath(new URL('./index.mjs', import.meta.url))
  const selectionPath = join(root, 'selection.json')
  writeFileSync(selectionPath, JSON.stringify({ 'not.configured': 'registry.example/unknown:1' }))
  const result = spawnSync(
    process.execPath,
    [cli, 'serve', '--config', configPath, '--selection-file', selectionPath],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Matrix component not\.configured is not mapped/)
})

test('should print CLI help without requiring a config file', () => {
  const cli = fileURLToPath(new URL('./index.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /validate\|matrix\|run\|run-matrix\|report\|serve/)
})

test('should reject a matrix component without a configured alias mapping', (t) => {
  const { configPath } = fixture(t, { components: { 'core.postgres': 'postgresdb' } })
  assert.throws(() => loadConfig(configPath, {}), /not mapped/)
})

test('should reject duplicate matrix images', (t) => {
  const { configPath } = fixture(t, {
    matrix: { 'services.catalog': ['registry.example/catalog:1', 'registry.example/catalog:1'] },
  })
  const config = loadConfig(configPath, {})
  assert.throws(() => expandMatrix(config.matrix, config), /Duplicate images/)
})

test('should reject a component that is neither a platform override nor a configured container', (t) => {
  const { configPath } = fixture(t, {
    matrix: { 'ui.shell': ['registry.example/shell:1'] },
    components: { 'ui.shell': 'shell-ui', 'core.postgres': 'postgresdb' },
  })
  assert.throws(() => loadConfig(configPath, {}), /not present in the platform overrides/)
})

test('should reject a missing explicit test image even when an override is set', (t) => {
  const { configPath } = fixture(t, { test: {} })
  assert.throws(() => loadConfig(configPath, { E2E_IMAGE: 'registry.example/tests:2' }), /test.image/)
})

test('should accept the configured test image override from E2E_IMAGE', (t) => {
  const { configPath } = fixture(t)
  const config = loadConfig(configPath, { E2E_IMAGE: 'registry.example/tests:2' })
  assert.equal(config.test.image, 'registry.example/tests:2')
})

test('should accept only JSON objects for opaque runtime inputs', (t) => {
  const { root } = fixture(t)
  assert.deepEqual(runtimeJson('{"custom":{"baseUrl":"https://app.example"}}', undefined, 'ENVIRONMENTS_JSON', root), {
    custom: { baseUrl: 'https://app.example' },
  })
  assert.deepEqual(runtimeJson(undefined, undefined, 'TEST_DATA_JSON', root), {})
  assert.throws(() => runtimeJson('[]', undefined, 'TEST_DATA_JSON', root), /JSON object/)
  assert.throws(
    () => runtimeJson('{}', 'missing.json', 'TEST_DATA_JSON', root),
    /only the JSON value or the file/
  )
})

test('should reject a selected image for a component outside the matrix config', (t) => {
  const { configPath } = fixture(t)
  const config = loadConfig(configPath, {})
  assert.throws(
    () => validateSelection({ 'core.postgres': 'registry.example/postgres:17' }, config),
    /not declared/
  )
})
