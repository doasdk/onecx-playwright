import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  checkLock, generatedFiles, imageVersion, installLock, loadVersions, main,
  readJson, synchronize, validateVersion
} from './versions.mjs'
import {
  assertSupportedIntegrationVersion, supportedIntegrationVersion
} from '../orchestrator/compatibility/supported-version.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(root, 'scripts', '.versions-test-'))
  fixtures.push(directory)
  for (const file of [
    'versions.json', 'scripts/Dockerfile.template', 'orchestrator/compatibility/compatibility.json',
    'orchestrator/package.json', 'orchestrator/package-lock.json',
    'tests/smoke/package.json', 'tests/smoke/package-lock.json'
  ]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    cpSync(join(root, file), join(directory, file))
  }
  synchronize(directory)
  return directory
}

function update(directory, file, change) {
  const value = readJson(directory, file)
  change(value)
  writeFileSync(join(directory, file), `${JSON.stringify(value, null, 2)}\n`)
}

function fakeInstall(directory, relative) {
  const manifest = readJson(directory, `${relative}/package.json`)
  update(directory, `${relative}/package-lock.json`, (lock) => {
    lock.version = manifest.version
    lock.packages[''] = { ...manifest }
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      lock.packages[`node_modules/${name}`].version = version
    }
    if (manifest.devDependencies?.['@playwright/test']) {
      for (const name of ['playwright', 'playwright-core']) {
        lock.packages[`node_modules/${name}`].version = manifest.devDependencies['@playwright/test']
      }
    }
  })
}

test('should derive runtime versions from the two digest-pinned images', () => {
  const versions = loadVersions(root)
  assert.equal(versions.node, versions.nodeImage.split(':')[1].split('-')[0])
  assert.equal(versions.playwright, readJson(root, 'tests/smoke/package.json').devDependencies['@playwright/test'])
})

for (const value of ['0.0.0', '12.3.4', '1.2.3-rc.1', '1.2.3-a.0+build.4']) {
  test(`should accept exact semantic version ${value}`, () => assert.equal(validateVersion(value, 'test'), value))
}

for (const value of [undefined, null, 1, '', '^1.2.3', 'v1.2.3', '01.2.3', '1.2', '1.2.3-01', '1.2.3\n']) {
  test(`should reject malformed semantic version ${String(value)}`, () => {
    assert.throws(() => validateVersion(value, 'test'), /Invalid test/)
  })
}

for (const value of [null, 22, 'node:latest', 'node:1.2.3-bookworm', `node:01.2.3-bookworm@sha256:${'a'.repeat(64)}`, `node:1.2.3-bookworm@sha256:${'z'.repeat(64)}`, `node:1.2.3-bookworm@sha256:${'a'.repeat(64)}\n`]) {
  test(`should reject incomplete image pin ${String(value)}`, () => {
    assert.throws(() => imageVersion(value, 'node'), /full versioned tag and sha256 digest/)
  })
}

test('should report unreadable version source explicitly', () => {
  assert.throws(() => readJson(root, 'scripts/nonexistent-versions.json'), /Cannot read scripts\/nonexistent-versions.json/)
})

test('should report malformed JSON explicitly', () => {
  const directory = fixture()
  writeFileSync(join(directory, 'versions.json'), '{')
  assert.throws(() => loadVersions(directory), /Cannot read versions.json/)
})

for (const config of [null, [], 'invalid']) {
  test(`should reject nonobject config ${JSON.stringify(config)}`, () => {
    const directory = fixture()
    writeFileSync(join(directory, 'versions.json'), JSON.stringify(config))
    assert.throws(() => loadVersions(directory), /Invalid versions.json/)
  })
}

test('should reject a dependency upgrade before generating files when the adapter baseline differs', () => {
  const directory = fixture()
  update(directory, 'versions.json', (config) => { config.integrationTests = '99.0.0' })
  const before = readFileSync(join(directory, 'orchestrator/package.json'), 'utf8')
  assert.throws(() => synchronize(directory), /review adapters and update compatibility baseline after verifying/)
  assert.equal(readFileSync(join(directory, 'orchestrator/package.json'), 'utf8'), before)
})

test('should reject unknown Dockerfile template variables', () => {
  const directory = fixture()
  writeFileSync(join(directory, 'scripts/Dockerfile.template'), '{{unknown}}\n')
  assert.throws(() => generatedFiles(directory, loadVersions(directory)), /Unknown Dockerfile template variable: unknown/)
})

test('should check generated files offline without rewriting or invoking npm', () => {
  const directory = fixture()
  const before = readFileSync(join(directory, 'Dockerfile'), 'utf8')
  synchronize(directory, { check: true, install: () => assert.fail('npm must not run') })
  assert.equal(readFileSync(join(directory, 'Dockerfile'), 'utf8'), before)
})

test('should sync unchanged manifests without invoking npm', () => {
  synchronize(fixture(), { install: () => assert.fail('npm must not run') })
})

test('should tolerate checkout CRLF in generated nonshell files without invoking npm', () => {
  const directory = fixture()
  const file = join(directory, 'orchestrator/package.json')
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\n', '\r\n'))
  synchronize(directory, { check: true, install: () => assert.fail('npm must not run') })
})

test('should reject a stale generated file without modifying it during check', () => {
  const directory = fixture()
  writeFileSync(join(directory, 'Dockerfile'), 'stale\n')
  assert.throws(() => synchronize(directory, { check: true }), /Stale generated file: Dockerfile/)
  assert.equal(readFileSync(join(directory, 'Dockerfile'), 'utf8'), 'stale\n')
})

test('should restore missing generated files during sync', () => {
  const directory = fixture()
  rmSync(join(directory, '.node-version'))
  synchronize(directory)
  assert.equal(readFileSync(join(directory, '.node-version'), 'utf8').trim(), loadVersions(directory).node)
})

test('should propagate file read failures other than missing files', () => {
  const directory = fixture()
  rmSync(join(directory, '.node-version'))
  mkdirSync(join(directory, '.node-version'))
  assert.throws(() => synchronize(directory), /EISDIR/)
})

test('should regenerate every active release pin using one command', () => {
  const directory = fixture()
  const installed = []
  main(['release', '9.8.7-rc.1'], directory, (base, relative) => {
    installed.push(relative)
    fakeInstall(base, relative)
  })
  assert.equal(readJson(directory, 'versions.json').release, '9.8.7-rc.1')
  assert.equal(readJson(directory, 'orchestrator/package.json').version, '9.8.7-rc.1')
  assert.equal(readJson(directory, 'orchestrator/package-lock.json').version, '9.8.7-rc.1')
  const dockerfile = readFileSync(join(directory, 'Dockerfile'), 'utf8')
  assert.ok(dockerfile.includes('org.opencontainers.image.version="9.8.7-rc.1"'))
  assert.ok(dockerfile.includes('org.opencontainers.image.version="9.8.7-rc.1-orchestrator"'))
  assert.deepEqual(installed, ['orchestrator'])
  main(['--check'], directory, () => assert.fail('check must remain offline'))
})

test('should update image-derived versions and only affected dependency locks', () => {
  const directory = fixture()
  const old = loadVersions(directory)
  update(directory, 'versions.json', (config) => {
    config.nodeImage = `node:30.2.1-bookworm-slim@sha256:${'a'.repeat(64)}`
    config.playwrightImage = `mcr.microsoft.com/playwright:v8.2.1-noble@sha256:${'b'.repeat(64)}`
  })
  const installed = []
  main(['sync'], directory, (base, relative) => {
    installed.push(relative)
    fakeInstall(base, relative)
  })
  const dockerfile = readFileSync(join(directory, 'Dockerfile'), 'utf8')
  assert.ok(dockerfile.includes('FROM node:30.2.1-bookworm-slim@sha256:'))
  assert.ok(dockerfile.includes('FROM mcr.microsoft.com/playwright:v8.2.1-noble@sha256:'))
  assert.ok(dockerfile.includes('"v30.2.1"'))
  assert.ok(dockerfile.includes('ONECX_PLAYWRIGHT_VERSION=8.2.1'))
  assert.equal(readFileSync(join(directory, '.node-version'), 'utf8'), '30.2.1\n')
  assert.equal(readJson(directory, 'tests/smoke/package.json').devDependencies['@playwright/test'], '8.2.1')
  assert.equal(readJson(directory, 'versions.json').release, old.release)
  assert.deepEqual(installed, ['tests/smoke'])
})

test('should update the orchestration dependency lock without changing the compatibility baseline', () => {
  const directory = fixture()
  const baseline = readFileSync(join(directory, 'orchestrator/compatibility/compatibility.json'), 'utf8')
  update(directory, 'versions.json', (config) => { config.allure = '9.8.7' })
  main(['sync'], directory, fakeInstall)
  assert.equal(readJson(directory, 'orchestrator/package.json').dependencies['allure-commandline'], '9.8.7')
  assert.equal(readFileSync(join(directory, 'orchestrator/compatibility/compatibility.json'), 'utf8'), baseline)
})

for (const mismatch of [false, true]) {
  test(`should ${mismatch ? 'reject mismatched' : 'verify manifest-derived'} installed Docker dependencies`, () => {
    const directory = fixture()
    const manifest = readJson(directory, 'orchestrator/package.json')
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const location = join(directory, 'orchestrator/node_modules', name)
      mkdirSync(location, { recursive: true })
      writeFileSync(join(location, 'package.json'), JSON.stringify({ version: mismatch ? '99.0.0' : version }))
    }
    const dockerfile = readFileSync(join(directory, 'Dockerfile'), 'utf8')
    const code = dockerfile.match(/&& node -e '([^']+)'/)[1]
    const result = spawnSync(process.execPath, ['-e', code], { cwd: join(directory, 'orchestrator'), encoding: 'utf8' })
    assert.equal(result.status, mismatch ? 1 : 0, result.stderr)
    if (mismatch) assert.match(result.stderr, /Installed version mismatch:/)
  })
}

test('should allow an explicitly reviewed baseline upgrade without automatically maintaining it', () => {
  const directory = fixture()
  update(directory, 'versions.json', (config) => { config.integrationTests = '9.8.7' })
  update(directory, 'orchestrator/compatibility/compatibility.json', (config) => { config.integrationTests = '9.8.7' })
  main(['sync'], directory, fakeInstall)
  assert.equal(readJson(directory, 'orchestrator/package.json').dependencies['@onecx/integration-tests'], '9.8.7')
})

for (const [field, value] of [['name', 'wrong-name'], ['version', '99.0.0'], ['dependencies', {}], ['devDependencies', {}]]) {
  test(`should reject stale root lock ${field}`, () => {
    const directory = fixture()
    update(directory, 'orchestrator/package-lock.json', (lock) => { lock.packages[''][field] = value })
    assert.throws(() => checkLock(directory, 'orchestrator'), new RegExp(`root ${field}`))
  })
}

test('should reject a lock without its root package entry', () => {
  const directory = fixture()
  update(directory, 'orchestrator/package-lock.json', (lock) => { delete lock.packages })
  assert.throws(() => checkLock(directory, 'orchestrator'), /root name/)
})

for (const [field, value] of [['name', 'wrong'], ['version', '99.0.0'], ['lockfileVersion', 2]]) {
  test(`should reject stale top-level lock ${field}`, () => {
    const directory = fixture()
    update(directory, 'orchestrator/package-lock.json', (lock) => { lock[field] = value })
    assert.throws(() => checkLock(directory, 'orchestrator'), /invalid lock metadata/)
  })
}

test('should reject a stale installed dependency even when root lock metadata matches', () => {
  const directory = fixture()
  update(directory, 'orchestrator/package-lock.json', (lock) => {
    lock.packages['node_modules/@onecx/integration-tests'].version = '99.0.0'
  })
  assert.throws(() => synchronize(directory, { check: true }), /installed @onecx\/integration-tests/)
})

test('should reject missing direct dependency lock entries', () => {
  const directory = fixture()
  update(directory, 'tests/smoke/package-lock.json', (lock) => { delete lock.packages['node_modules/@playwright/test'] })
  assert.throws(() => checkLock(directory, 'tests/smoke'), /installed @playwright\/test/)
})

for (const name of ['playwright', 'playwright-core']) {
  test(`should reject stale transitive ${name} browser tooling in the smoke lock`, () => {
    const directory = fixture()
    update(directory, 'tests/smoke/package-lock.json', (lock) => { lock.packages[`node_modules/${name}`].version = '99.0.0' })
    assert.throws(() => checkLock(directory, 'tests/smoke'), new RegExp(`installed ${name} differs`))
  })
}

for (const change of [
  (entry) => { entry.link = true },
  (entry) => { delete entry.integrity },
  (entry) => { delete entry.resolved },
  (entry) => { entry.resolved = 'file:../private' },
  (entry) => { entry.resolved = 'https://secret@registry.npmjs.org/private' },
  (entry) => { entry.resolved = 'https://registry.npmjs.org/private?token=secret' }
]) {
  test(`should reject unsafe registry lock data: ${change}`, () => {
    const directory = fixture()
    update(directory, 'tests/smoke/package-lock.json', (lock) => change(lock.packages['node_modules/@playwright/test']))
    assert.throws(() => checkLock(directory, 'tests/smoke'), /Unsafe tests\/smoke\/package-lock.json entry/)
  })
}

test('should not fetch a stale lock when no manifest changed', () => {
  const directory = fixture()
  update(directory, 'tests/smoke/package-lock.json', (lock) => { lock.version = '99.0.0' })
  assert.throws(() => synchronize(directory, { install: () => assert.fail('unchanged manifests must not invoke npm') }), /invalid lock metadata/)
})

for (const args of [[], ['unknown'], ['release'], ['check', 'extra'], ['sync', 'extra'], ['release', '1.2.3', 'extra']]) {
  test(`should reject invalid CLI arguments ${JSON.stringify(args)}`, () => {
    assert.throws(() => main(args, root), /Usage:/)
  })
}

test('should reject a malformed release without writing source', () => {
  const directory = fixture()
  const before = readFileSync(join(directory, 'versions.json'), 'utf8')
  assert.throws(() => main(['release', 'not-a-version'], directory), /Invalid release/)
  assert.equal(readFileSync(join(directory, 'versions.json'), 'utf8'), before)
})

test('should execute the offline check CLI successfully', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/versions.mjs'), 'check'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('should exit nonzero with an explicit CLI error', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/versions.mjs'), 'unknown'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /versions: Usage:/)
})

for (const platform of ['win32', 'linux']) {
  test(`should invoke npm package-lock-only safely on ${platform}`, () => {
    installLock(root, 'orchestrator', (command, args, options) => {
      assert.equal(command, platform === 'win32' ? 'npm.cmd' : 'npm')
      assert.deepEqual(args, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
      assert.equal(options.cwd, join(root, 'orchestrator'))
      assert.equal(options.shell, platform === 'win32')
      return { status: 0 }
    }, platform)
  })
}

for (const result of [{ error: new Error('npm unavailable') }, { status: 1 }]) {
  test(`should report npm lock generation failure ${String(result.error ?? result.status)}`, () => {
    assert.throws(() => installLock(root, 'orchestrator', () => result), /npm lock update failed for orchestrator:.*retry npm install/)
  })
}

test('should accept only the manually reviewed adapter baseline', () => {
  assert.doesNotThrow(() => assertSupportedIntegrationVersion(supportedIntegrationVersion))
})

test('should reject unreviewed integration versions independently of release metadata', () => {
  assert.throws(() => assertSupportedIntegrationVersion('99.0.0'), /review adapters and update compatibility baseline after verifying/)
})

for (const name of ['keycloak-startup', 'service-health', 'ui-cors', 'run-context']) {
  for (const unsupportedVersion of [false, true]) {
    test(`should reject ${unsupportedVersion ? 'an unreviewed package version' : 'unknown package source'} in the ${name} adapter`, () => {
      const directory = fixture()
      const adapters = join(directory, 'orchestrator/compatibility')
      for (const file of [`patch-${name}.mjs`, 'supported-version.mjs']) {
        cpSync(join(root, 'orchestrator/compatibility', file), join(adapters, file))
      }
      const packageRoot = join(directory, 'orchestrator/node_modules/@onecx/integration-tests')
      for (const [file, contents] of Object.entries({
        'package.json': JSON.stringify({ main: 'index.js', version: unsupportedVersion ? '99.0.0' : supportedIntegrationVersion }),
        'index.js': '',
        'lib/containers/core/onecx-keycloak.js': 'unknown implementation',
        'assets/keycloak/realm-onecx.json': '{"realm":"onecx","attributes":{}}',
        'lib/containers/basic/onecx-svc.js': 'unknown implementation',
        'lib/containers/basic/onecx-ui.js': 'unknown implementation',
        'lib/utils/run-context.js': 'unknown implementation'
      })) {
        mkdirSync(dirname(join(packageRoot, file)), { recursive: true })
        writeFileSync(join(packageRoot, file), contents)
      }
      const result = spawnSync(process.execPath, [join(adapters, `patch-${name}.mjs`)], { encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, unsupportedVersion
        ? /review adapters and update compatibility baseline after verifying/
        : /Unexpected .*Refusing to apply/)
    })
  }
}
