import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { executeImage } from './execute-image.mjs'
import { runtimeContractLabel, runtimeEnvelope } from './image-execution-contract.mjs'

async function execute(overrides = {}) {
  const root = mkdtempSync(join(import.meta.dirname, '.test-executor-'))
  const secretDir = join(root, 'private')
  const runDir = join(root, 'work')
  mkdirSync(secretDir)
  mkdirSync(join(runDir, 'e2e'), { recursive: true })
  writeFileSync(join(runDir, 'e2e', 'ca.pem'), 'private-ca')
  const calls = []
  let runtime
  let child
  const docker = (args) => {
    calls.push(args)
    if (args[0] === 'image') {
      const labels = overrides.legacy ? null : { [runtimeContractLabel]: overrides.contract || '1' }
      return JSON.stringify(labels)
    }
    if (args[0] === 'create' && overrides.createError) throw new Error('container create failed')
    if (args[0] === 'cp' && args[1] === join(secretDir, 'runtime.json')) {
      runtime = JSON.parse(readFileSync(args[1], 'utf8'))
      if (overrides.runtimeCopyError) throw new Error('runtime copy failed')
    }
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
        ...(overrides.agentConfig === undefined ? {} : { agentConfig: overrides.agentConfig }),
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
    return { records, calls, runtime, logCaptured: existsSync(join(runDir, 'e2e-results', 'custom-e2e', 'container.log')) }
  } catch (error) {
    error.calls = calls
    throw error
  } finally {
    assert.equal(existsSync(join(secretDir, 'runtime.json')), false, 'Credential-bearing runtime envelope must be removed.')
    if (overrides.agentConfig !== undefined) assert.equal(existsSync(join(secretDir, 'e2e.log')), false)
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

for (const legacy of [false, true]) {
  test(`should forward only explicit agent configuration privately for legacy=${legacy}`, async () => {
    const agentConfig = JSON.stringify({
      anthropicBaseUrl: 'https://model-gateway.example', model: 'test-model', authToken: 'private-agent-token',
    })
    const { calls, runtime } = await execute({ legacy, agentConfig })
    assert.equal(legacy ? runtime.agentConfig : runtime.environment.AGENT_CONFIG_JSON, agentConfig)
    assert.doesNotMatch(JSON.stringify(calls), /private-agent-token/)
  })
}

for (const legacy of [false, true]) {
  for (const options of [{}, { timeout: true, noManifest: true, exitCode: 137 }, { createError: true },
    { runtimeCopyError: true }, { spawnError: true }, { copyError: true }]) {
    test(`should remove provider envelopes and suppress raw captured logs for legacy=${legacy} options=${JSON.stringify(options)}`, async () => {
      const agentConfig = JSON.stringify({
        anthropicBaseUrl: 'https://model.example', model: 'test', apiKey: 'private-provider-token'
      })
      const execution = execute({ legacy, capture: true, agentConfig, ...options })
      if (options.createError || options.runtimeCopyError || options.spawnError || options.copyError) {
        await assert.rejects(execution)
      } else {
        assert.equal((await execution).logCaptured, false)
      }
    })
  }
}

test('should reject invalid agent configuration without exposing values', async () => {
  await assert.rejects(execute({ agentConfig: 'private-invalid-json' }),
    /^Error: AGENT_CONFIG_JSON must contain a valid agent configuration\.$/)
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
