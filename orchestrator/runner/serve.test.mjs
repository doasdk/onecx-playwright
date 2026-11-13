import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './matrix.mjs'
import { servePlatform } from './serve.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'onecx-it-serve-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(
    join(root, 'platform.json'),
    JSON.stringify({
      platformConfig: {
        importData: false,
        platformOverrides: { services: { catalog: { image: 'registry.example/catalog:1' } } },
        container: { e2e: [{ networkAlias: 'catalog-e2e' }] },
      },
    })
  )
  const configPath = join(root, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      platform: { config: 'platform.json' },
      test: { image: 'registry.example/tests:1' },
      matrix: { 'services.catalog': ['registry.example/catalog:2'] },
      components: { 'services.catalog': 'catalog-svc' },
    })
  )
  return { root, config: loadConfig(configPath, {}) }
}

test('should keep the selected platform online until interrupted, then clean up', async (t) => {
  const { root, config } = fixture(t)
  const calls = []
  const env = {}
  class PlatformManager {
    constructor(file) {
      const { platformConfig } = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(platformConfig.platformOverrides.services.catalog.image, 'registry.example/catalog:2')
      this.containers = new Map([['catalog-svc', { getId: () => 'catalog-container' }]])
    }
    hasValidatedConfig() {
      return true
    }
    async startContainers() {
      calls.push('start')
    }
    async getPlatformInfo() {
      return {
        network: { id: 'platform-network' },
        external: { shellUi: 'https://localhost:4200', keycloak: 'https://localhost:8443' },
      }
    }
    async exportPlatformInfo() {
      calls.push('export')
    }
    async checkAllHealthy() {
      calls.push('health')
    }
    getAllContainers() {
      return this.containers
    }
    async stopAllContainers() {
      calls.push('stop')
    }
  }
  const summary = await servePlatform(config, {
    env,
    selection: { 'services.catalog': 'registry.example/catalog:2' },
    runId: 'serve-catalog',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: 'catalog-image-id' }),
    docker: (args) => {
      if (args[0] === 'inspect') return 'catalog-image-id'
      return ''
    },
    waitForSignal: async () => {
      calls.push('wait')
      return 'SIGINT'
    },
  })

  assert.deepEqual(calls, ['start', 'export', 'health', 'wait', 'stop'])
  assert.equal(summary.mode, 'platform-only')
  assert.equal(summary.status, 'interrupted')
  assert.equal(summary.exitCode, 130)
  assert.equal(summary.imageStatus.status, 'verified')
  assert.equal(env.RUN_ID, undefined)
  const saved = JSON.parse(readFileSync(join(root, 'results', 'serve-catalog', 'summary.json'), 'utf8'))
  assert.equal(saved.interruptedBy, 'SIGINT')
  assert.equal(saved.imageStatus.verified, 1)
})

test('should clean up platform after startup or health failure', async (t) => {
  const { root, config } = fixture(t)
  let stopped = false
  class PlatformManager {
    hasValidatedConfig() {
      return true
    }
    async startContainers() {}
    async getPlatformInfo() {
      return { network: { id: 'platform-network' } }
    }
    async exportPlatformInfo() {}
    async checkAllHealthy() {
      throw new Error('Unhealthy platform.')
    }
    getAllContainers() {
      return new Map([['catalog-svc', { getId: () => 'catalog-container' }]])
    }
    async stopAllContainers() {
      stopped = true
    }
  }
  const summary = await servePlatform(config, {
    env: {},
    runId: 'serve-health-failure',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: 'catalog-image-id' }),
    docker: (args) => (args[0] === 'inspect' ? 'catalog-image-id' : ''),
    waitForSignal: async () => {
      throw new Error('The server must not wait after health failure.')
    },
  })

  assert.equal(summary.status, 'failure')
  assert.equal(summary.failureStage, 'image-verification')
  assert.equal(stopped, true)
})
