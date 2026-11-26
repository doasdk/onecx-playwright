import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertConfigSourcePath, loadConfigSource } from './config-source.mjs'
import { loadConfig } from './matrix.mjs'

function fixture(t) {
  const root = mkdtempSync(join(process.cwd(), '.config-inheritance-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const baseDirectory = join(root, 'base')
  const childDirectory = join(root, 'lanes', 'agent')
  mkdirSync(baseDirectory, { recursive: true })
  mkdirSync(childDirectory, { recursive: true })
  const baseFile = join(baseDirectory, 'integration.json')
  const childFile = join(childDirectory, 'integration.json')
  const platform = {
    platformConfig: {
      platformOverrides: { ui: { catalog: { image: 'registry.example/catalog:1' } } },
      container: { e2e: [{ networkAlias: 'catalog-e2e' }] },
    },
  }
  const matrix = { 'ui.catalog': ['registry.example/catalog:1'] }
  const base = {
    schemaVersion: 1,
    platform: { config: './platform.json' },
    matrix: './versions.json',
    test: { image: 'registry.example/tests:1', script: 'tests:gui', timeoutMs: 2000, baseUrl: 'https://example.test' },
    components: { 'ui.catalog': 'catalog-ui' },
    environment: 'custom',
    artifacts: { capturePrivate: true },
  }
  const child = {
    schemaVersion: 1,
    extends: '../../base/integration.json',
    test: { image: 'registry.example/agent:1', script: 'tests:agent', timeoutMs: 3000 },
  }
  const write = (file, value) => writeFileSync(file, JSON.stringify(value))
  write(baseFile, base)
  write(childFile, child)
  write(join(baseDirectory, 'platform.json'), platform)
  write(join(baseDirectory, 'versions.json'), matrix)
  return { root, baseDirectory, childDirectory, baseFile, childFile, base, child, platform, matrix, write }
}

test('should inherit sections without rebasing their paths when the child is in another directory', (t) => {
  const f = fixture(t)
  const loaded = loadConfig(f.childFile, {})
  assert.equal(loaded.platformPath, join(f.baseDirectory, 'platform.json'))
  assert.equal(loaded.matrixPath, join(f.baseDirectory, 'versions.json'))
  assert.deepEqual(loaded.matrix, f.matrix)
  assert.deepEqual(loaded.components, f.base.components)
  assert.equal(loaded.environment, 'custom')
  assert.deepEqual(loaded.artifacts, { capturePrivate: true })
  assert.equal(loaded.configDirectory, f.childDirectory)
  assert.equal(Object.hasOwn(loaded, 'extends'), false)
})

test('should replace the whole test section when a child supplies an agent lane', (t) => {
  const f = fixture(t)
  assert.deepEqual(loadConfig(f.childFile, {}).test, f.child.test)
})

test('should apply runtime image overrides when the test section is inherited', (t) => {
  const f = fixture(t)
  delete f.child.test
  f.write(f.childFile, f.child)
  assert.deepEqual(loadConfig(f.childFile, { E2E_IMAGE: 'registry.example/override:2' }).test, {
    ...f.base.test,
    image: 'registry.example/override:2',
  })
})

test('should preserve the nearest declaring directory when inheritance has multiple levels', (t) => {
  const f = fixture(t)
  const middleFile = join(f.root, 'middle.json')
  f.write(middleFile, { schemaVersion: 1, extends: './base/integration.json', matrix: './middle-versions.json' })
  f.write(join(f.root, 'middle-versions.json'), { 'ui.catalog': ['registry.example/catalog:2'] })
  f.write(f.childFile, { ...f.child, extends: '../../middle.json' })
  const loaded = loadConfig(f.childFile, {})
  assert.equal(loaded.matrixPath, join(f.root, 'middle-versions.json'))
  assert.equal(loaded.platformPath, join(f.baseDirectory, 'platform.json'))
})

test('should resolve child paths from the child when platform and matrix sections are replaced', (t) => {
  const f = fixture(t)
  f.write(join(f.childDirectory, 'platform.json'), f.platform)
  f.write(join(f.childDirectory, 'versions.json'), f.matrix)
  f.write(f.childFile, { ...f.child, platform: { config: './platform.json' }, matrix: './versions.json' })
  const loaded = loadConfig(f.childFile, {})
  assert.equal(loaded.platformPath, join(f.childDirectory, 'platform.json'))
  assert.equal(loaded.matrixPath, join(f.childDirectory, 'versions.json'))
})

test('should retain absolute paths when inherited platform and matrix references are absolute', (t) => {
  const f = fixture(t)
  f.write(f.baseFile, {
    ...f.base,
    platform: { config: join(f.baseDirectory, 'platform.json') },
    matrix: join(f.baseDirectory, 'versions.json'),
  })
  assert.equal(loadConfig(f.childFile, {}).platformPath, join(f.baseDirectory, 'platform.json'))
})

test('should replace component mappings and inline matrices instead of deep merging when the child supplies them', (t) => {
  const f = fixture(t)
  f.platform.platformConfig.platformOverrides.ui.other = { image: 'registry.example/other:1' }
  f.write(join(f.baseDirectory, 'platform.json'), f.platform)
  f.write(f.baseFile, { ...f.base, components: { ...f.base.components, 'ui.other': 'other-ui' } })
  f.write(f.childFile, { ...f.child, components: f.base.components, matrix: f.matrix })
  const loaded = loadConfig(f.childFile, {})
  assert.deepEqual(loaded.components, f.base.components)
  assert.deepEqual(loaded.matrix, f.matrix)
})

test('should replace artifact policy when the child explicitly disables private capture', (t) => {
  const f = fixture(t)
  f.write(f.childFile, { ...f.child, artifacts: { capturePrivate: false }, environment: 'container', matrix: f.matrix })
  const loaded = loadConfig(f.childFile, {})
  assert.deepEqual(loaded.artifacts, { capturePrivate: false })
  assert.equal(loaded.environment, 'container')
})

for (const value of [null, [], 1, {}, { schemaVersion: 2 }]) {
  test(`should reject an invalid configuration object when the file contains ${JSON.stringify(value)}`, (t) => {
    const f = fixture(t)
    f.write(f.childFile, value)
    assert.throws(() => loadConfigSource(f.childFile), /schemaVersion: 1/)
  })
}

for (const value of [null, '', '  ', 1, [], {}]) {
  test(`should reject an invalid extends reference when its value is ${JSON.stringify(value)}`, (t) => {
    const f = fixture(t)
    f.write(f.childFile, { ...f.child, extends: value })
    assert.throws(() => loadConfigSource(f.childFile), /Configuration.extends must name/)
  })
}

test('should reject malformed JSON when an inherited file cannot be parsed', (t) => {
  const f = fixture(t)
  writeFileSync(f.baseFile, '{')
  assert.throws(() => loadConfigSource(f.childFile), /must contain valid JSON/)
})

test('should reject missing files when an extends target is absent', (t) => {
  const f = fixture(t)
  f.write(f.childFile, { ...f.child, extends: './missing.json' })
  assert.throws(() => loadConfigSource(f.childFile), /file does not exist:.*missing.json/)
})

test('should reject a direct cycle when the config extends itself through a normalized path', (t) => {
  const f = fixture(t)
  f.write(f.childFile, { ...f.child, extends: './other/../integration.json' })
  assert.throws(() => loadConfigSource(f.childFile), /extends cycle/)
})

test('should reject an indirect cycle when a base points back at the child', (t) => {
  const f = fixture(t)
  f.write(f.baseFile, { ...f.base, extends: '../lanes/agent/integration.json' })
  assert.throws(() => loadConfigSource(f.childFile), /extends cycle/)
})

for (const location of ['baseFile', 'childFile']) {
  for (const key of ['component', '__proto__', 'constructor', 'prototype']) {
    test(`should reject unknown key ${key} when declared in an inheritance chain's ${location}`, (t) => {
      const f = fixture(t)
      const value = location === 'baseFile' ? f.base : f.child
      f.write(f[location], { ...value, [key]: { polluted: true } })
      assert.throws(() => loadConfigSource(f.childFile), /Unknown configuration key/)
      assert.equal({}.polluted, undefined)
    })
  }
}

test('should retain unknown standalone keys when loading existing configs without inheritance', (t) => {
  const f = fixture(t)
  f.write(f.baseFile, { ...f.base, legacyExtension: true })
  assert.equal(loadConfig(f.baseFile, {}).legacyExtension, true)
})

test('should accept editor metadata when configs specify a schema', (t) => {
  const f = fixture(t)
  f.write(f.childFile, { ...f.child, $schema: './schema.json' })
  assert.equal(loadConfig(f.childFile, {}).$schema, './schema.json')
})

test('should load inherited configuration when all files remain in the staged source root', (t) => {
  const f = fixture(t)
  assert.equal(loadConfig(f.childFile, { ONECX_CONFIG_SOURCE_ROOT: f.root }).platformPath, join(f.baseDirectory, 'platform.json'))
})

test('should reject a selected configuration when it is outside the staged source root', (t) => {
  const f = fixture(t)
  assert.throws(() => loadConfig(f.childFile, { ONECX_CONFIG_SOURCE_ROOT: f.baseDirectory }), /staged source directory/)
})

test('should reject an inherited configuration when its base escapes the staged source root', (t) => {
  const f = fixture(t)
  assert.throws(() => loadConfig(f.childFile, { ONECX_CONFIG_SOURCE_ROOT: f.childDirectory }), /staged source directory/)
})

test('should reject a parent directory when checking staged source confinement', (t) => {
  const f = fixture(t)
  assert.throws(() => assertConfigSourcePath(f.root, f.baseDirectory), /staged source directory/)
})

test('should reject symlink escapes when an inherited configuration points outside staged source', (t) => {
  const f = fixture(t)
  symlinkSync(f.baseDirectory, join(f.childDirectory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  f.write(f.childFile, { ...f.child, extends: './linked/integration.json' })
  assert.throws(() => loadConfig(f.childFile, { ONECX_CONFIG_SOURCE_ROOT: f.childDirectory }), /staged source directory/)
})

for (const section of ['platform', 'matrix']) {
  test(`should reject external ${section} files when staging confines configuration to the checkout`, (t) => {
    const f = fixture(t)
    const config = {
      ...f.base,
      platform: { config: './platform.json' },
      matrix: './versions.json',
      [section]: section === 'platform' ? { config: join(f.baseDirectory, 'platform.json') } : join(f.baseDirectory, 'versions.json'),
    }
    f.write(f.childFile, config)
    f.write(join(f.childDirectory, 'platform.json'), f.platform)
    f.write(join(f.childDirectory, 'versions.json'), f.matrix)
    assert.throws(() => loadConfig(f.childFile, { ONECX_CONFIG_SOURCE_ROOT: f.childDirectory }), /staged source directory/)
  })
}

for (const section of ['test', 'platform', 'components', 'matrix']) {
  test(`should validate replacement ${section} when the child supplies null instead of inheriting`, (t) => {
    const f = fixture(t)
    f.write(f.childFile, { ...f.child, [section]: null })
    assert.throws(() => loadConfig(f.childFile, {}), /Configuration\./)
  })
}

for (const command of ['validate', 'matrix', 'report', 'run', 'serve']) {
  test(`should resolve inheritance before executing the ${command} command`, (t) => {
    const f = fixture(t)
    const cli = fileURLToPath(new URL('./index.mjs', import.meta.url))
    const args = [cli, command, '--config', f.childFile]
    if (['run', 'serve'].includes(command)) {
      const selection = join(f.root, 'invalid-selection.json')
      f.write(selection, { 'ui.unknown': 'registry.example/unknown:1' })
      args.push('--selection-file', selection)
    }
    if (command === 'report') {
      mkdirSync(join(f.root, 'results'))
      f.write(join(f.root, 'results', 'matrix-index-input.json'), [])
    }
    const result = spawnSync(process.execPath, args, { cwd: f.root, encoding: 'utf8' })
    if (command === 'validate') {
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Configuration valid/)
    } else if (command === 'matrix') {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).include[0].testImage, f.child.test.image)
    } else if (command === 'report') {
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Matrix report index:/)
    } else {
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Matrix component ui.unknown is not mapped/)
    }
  })
}

test('should publish an editor schema with the supported inheritance keys when describing configuration', () => {
  const schema = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config.schema.json'), 'utf8'))
  assert.equal(schema.properties.extends.type, 'string')
  assert.deepEqual(schema.then.propertyNames.enum.sort(), Object.keys(schema.properties).sort())
})
