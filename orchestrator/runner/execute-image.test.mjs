import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeImage } from './execute-image.mjs'
import { runtimeContractLabel, runtimeEnvelope } from './image-execution-contract.mjs'

async function execute(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'onecx-it-executor-'))
  const secretDir = join(root, 'private')
  const runDir = join(root, 'work')
  mkdirSync(secretDir)
  mkdirSync(join(runDir, 'e2e'), { recursive: true })
  writeFileSync(join(runDir, 'e2e', 'ca.pem'), 'private-ca')
  const calls = []
  let child
  const docker = (args) => {
    calls.push(args)
    if (args[0] === 'image') {
      const labels = overrides.legacy ? null : { [runtimeContractLabel]: overrides.contract || '1' }
      return JSON.stringify(labels)
    }
    if (args[0] === 'create' && overrides.createError) throw new Error('container create failed')
    if (args[0] === 'kill') {
      if (overrides.killError) throw new Error('container kill failed')
      setImmediate(() => child.emit('exit', 137))
    }
    if (args[0] === 'inspect') {
      if (args[1] === '--format' && args[2] === '{{.Image}}') return overrides.actualImageId || 'image-id'
      return JSON.stringify({ Status: overrides.state || 'exited', ExitCode: overrides.exitCode ?? 0 })
    }
    if (args[0] === 'cp' && args[1].endsWith('/e2e-results/.')) {
      if (overrides.copyError) throw new Error('artifact copy failed')
      if (!overrides.noManifest && !overrides.legacy) {
        writeFileSync(
          join(args[2], 'execution.json'),
          JSON.stringify({
            version: 1,
            status: overrides.status || 'success',
            exitCode: overrides.exitCode ?? 0,
          })
        )
      }
    }
    return ''
  }
  const spawn = () => {
    child = new EventEmitter()
    if (!overrides.timeout) {
      setImmediate(() => child.emit(overrides.spawnError ? 'error' : 'exit', overrides.spawnError ? new Error('attach failed') : 0))
    }
    return child
  }
  try {
    const records = await executeImage(
      {
        image: 'registry.example/tests:1',
        metadata: { network: { id: 'net-id' }, e2e: { baseUrl: 'https://app.example', keycloakUrl: '' } },
        environments: { project: { baseUrl: 'https://custom.example' } },
        data: { fixtures: [{ value: 7 }] },
        environment: 'custom',
        script: 'tests:gui',
        capture: !!overrides.capture,
        secretDir,
        runDir,
        alias: 'custom-e2e',
        timeoutMs: overrides.timeout ? 5 : 1000,
        expectedImageId: 'image-id',
        onImageVerified: () => calls.push(['image-verified']),
        onContainer: (name) => {
          if (name) calls.push(['active', name])
        },
        ...(overrides.interrupted ? { isInterrupted: () => true } : {}),
      },
      { docker, spawn }
    )
    return { records, calls, runtime: JSON.parse(readFileSync(join(secretDir, 'runtime.json'), 'utf8')) }
  } catch (error) {
    error.calls = calls
    throw error
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('should keep the runtime contract v1 envelope shape unchanged', () => {
  const metadata = { e2e: { baseUrl: 'https://app.example' } }
  const environments = { custom: { appUrl: 'https://custom.example' } }
  const data = { records: [] }
  assert.deepEqual(runtimeEnvelope({ metadata, environments, data, environment: 'custom', script: 'tests:gui', capture: false }), {
    version: 1,
    script: 'tests:gui',
    config: 'playwright.config.ts',
    environment: {
      CI: 'true',
      ENV: 'custom',
      ENVIRONMENTS_JSON: JSON.stringify(environments),
      TEST_DATA_JSON: JSON.stringify(data),
      BASE_URL: metadata.e2e.baseUrl,
      PLATFORM_INFO_JSON: JSON.stringify(metadata),
      TLS_CA_CERT_PATH: '/tmp/onecx-ca.pem',
      OUTPUT_DIR: '/e2e-results',
      CAPTURE_PRIVATE_ARTIFACTS: 'false',
    },
  })
})

test('should run the selected image through the inherited entrypoint', async () => {
  const { calls, records, runtime } = await execute()
  const create = calls.find(([name]) => name === 'create')
  assert.ok(create.includes('--init'))
  assert.ok(create.includes('ONECX_RUNTIME_FILE=/tmp/onecx-runtime.json'))
  assert.ok(!create.includes('--entrypoint'))
  assert.equal(runtime.version, 1)
  assert.equal(records[0].status, 'success')
  assert.ok(calls.some(([name]) => name === 'image-verified'))
  assert.ok(calls.some(([name, path]) => name === 'cp' && path.endsWith('ca.pem')))
  assert.equal(calls.at(-1)[0], 'rm')
})

test('should preserve opaque runtime configuration when running an older image', async () => {
  const { calls, records, runtime } = await execute({ legacy: true, noManifest: true, exitCode: 1 })
  assert.ok(calls.find(([name]) => name === 'create').includes('--entrypoint'))
  assert.ok(calls.some(([name, path]) => name === 'cp' && path.endsWith('image-bootstrap.cjs')))
  assert.deepEqual(runtime.environments, { project: { baseUrl: 'https://custom.example' } })
  assert.deepEqual(runtime.data, { fixtures: [{ value: 7 }] })
  assert.equal(records[0].status, 'failed')
})

test('should report the container runtime status when tests fail', async () => {
  const { records } = await execute({ exitCode: 1, status: 'test-failed' })
  assert.equal(records[0].status, 'test-failed')
  assert.equal(records[0].success, false)
})

test('should terminate an E2E container after its timeout', async () => {
  const { calls, records } = await execute({ timeout: true, noManifest: true, exitCode: 137 })
  assert.ok(calls.some(([name]) => name === 'kill'))
  assert.equal(records[0].status, 'timeout')
})

test('should terminate an E2E container when interrupted during startup', async () => {
  const { calls } = await execute({ interrupted: true })
  assert.ok(calls.some(([name, signal]) => name === 'kill' && signal === '--signal'))
})

for (const [options, expected] of [
  [{ actualImageId: 'unexpected-image-id' }, /unexpected image/],
  [{ contract: '2' }, /Unsupported/],
  [{ createError: true }, /create failed/],
  [{ spawnError: true }, /attach failed/],
  [{ state: 'running' }, /did not exit/],
  [{ copyError: true }, /copy failed/],
  [{ noManifest: true }, /ENOENT/],
  [{ timeout: true, killError: true }, /kill failed/],
]) {
  test(`should fail and clean up for executor error ${JSON.stringify(options)}`, async () => {
    await assert.rejects(execute(options), (error) => {
      assert.match(error.message, expected)
      if (error.calls.some(([name]) => name === 'cp')) assert.equal(error.calls.at(-1)[0], 'rm')
      return true
    })
  })
}
