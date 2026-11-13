import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './matrix.mjs'
import { resolveImage, runSingle } from './run.mjs'

for (const ci of [undefined, '', 'false', 'true', '1']) {
  test(`should resolve a local image with the correct pull policy when CI is ${JSON.stringify(ci)}`, () => {
    const calls = []
    const image = resolveImage('app-e2e:local', { CI: ci }, (args) => {
      calls.push(args)
      return args[0] === 'image' ? JSON.stringify([{ Id: 'sha256:local' }]) : ''
    })
    assert.equal(image.imageId, 'sha256:local')
    assert.equal(calls.some(([command]) => command === 'pull'), ci === 'true' || ci === '1')
  })
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'onecx-it-run-'))
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
      test: { image: 'registry.example/tests:1', script: 'tests:gui', timeoutMs: 1000 },
      environment: 'custom',
      components: { 'services.catalog': 'catalog-svc' },
    })
  )
  return { root, config: loadConfig(configPath, {}) }
}

test('should execute a custom application with opaque runtime objects and no Workspace shell settings', async (t) => {
  const { root, config } = fixture(t)
  const env = {
    ENVIRONMENTS_JSON: JSON.stringify({ custom: { appUrl: 'https://catalog.example' } }),
    TEST_DATA_JSON: JSON.stringify({ records: [{ name: 'sample' }] }),
  }
  const calls = []
  const expectedImage = 'sha256:catalog'
  class PlatformManager {
    constructor(file) {
      const platform = JSON.parse(readFileSync(file, 'utf8')).platformConfig
      assert.equal(platform.container.e2e[0].networkAlias, 'catalog-e2e')
      assert.equal(platform.container.adminShell, undefined)
      this.containers = new Map([
        ['catalog-svc', { getId: () => 'container-catalog' }],
      ])
    }
    hasValidatedConfig() {
      return true
    }
    async startContainers() {}
    async getPlatformInfo() {
      return { network: { id: 'platform-network' }, e2e: { baseUrl: 'https://app.example' } }
    }
    async exportPlatformInfo() {}
    async checkAllHealthy() {}
    getAllContainers() {
      return this.containers
    }
    async stopAllContainers() {
      calls.push('cleanup')
    }
  }
  const summary = await runSingle(config, {
    env,
    runId: 'catalog-run',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: expectedImage }),
    docker: (args) => {
      calls.push(args)
      if (args[0] === 'inspect') return expectedImage
      return ''
    },
    executeImage: async (options) => {
      assert.deepEqual(options.environments, { custom: { appUrl: 'https://catalog.example' } })
      assert.deepEqual(options.data, { records: [{ name: 'sample' }] })
      assert.equal(options.environment, 'custom')
      assert.equal(options.script, 'tests:gui')
      assert.equal(options.metadata.e2e.baseUrl, 'https://app.example')
      options.onImageVerified()
      return [
        {
          networkAlias: options.alias,
          sequence: 1,
          total: 1,
          status: 'success',
          success: true,
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 2,
        },
      ]
    },
  })
  assert.equal(summary.status, 'success')
  assert.ok(calls.includes('cleanup'))
  assert.equal(env.ARTIFACTS_ROOT, undefined)
  const publicSummary = JSON.parse(readFileSync(join(root, 'results', 'catalog-run', 'summary.json'), 'utf8'))
  assert.equal(publicSummary.status, 'success')
  assert.equal(publicSummary.e2eAggregate.succeeded, 1)
  assert.equal(publicSummary.testStatus, 'success')
  assert.equal(publicSummary.allureReportStatus, 'not-generated')
  assert.equal(publicSummary.imageStatus.status, 'verified')
  assert.equal(publicSummary.imageStatus.verified, 2)
  assert.equal(
    JSON.parse(readFileSync(join(root, 'results', 'catalog-run', 'versions.json'), 'utf8')).images[
      'services.catalog'
    ].verified,
    true
  )
})

test('should fail the run when the started container image differs from the selected image', async (t) => {
  const { root, config } = fixture(t)
  let cleanupCalled = false
  class PlatformManager {
    constructor() {
      this.containers = new Map([['catalog-svc', { getId: () => 'container-catalog' }]])
    }
    hasValidatedConfig() {
      return true
    }
    async startContainers() {}
    async getPlatformInfo() {
      return { network: { id: 'platform-network' }, e2e: { baseUrl: 'https://app.example' } }
    }
    async exportPlatformInfo() {}
    async checkAllHealthy() {}
    getAllContainers() {
      return this.containers
    }
    async stopAllContainers() {
      cleanupCalled = true
    }
  }
  const summary = await runSingle(config, {
    env: {},
    runId: 'catalog-mismatch',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: `expected:${image}` }),
    docker: () => 'unexpected-image-id',
    executeImage: async () => {
      throw new Error('Executor must not run after image verification fails.')
    },
  })
  assert.equal(summary.status, 'failure')
  assert.equal(summary.failureStage, 'image-verification')
  assert.equal(cleanupCalled, true)
})

test('should verify the importer image and require a successful import exit code', async (t) => {
  const { root, config: originalConfig } = fixture(t)
  const platformPath = join(root, 'platform.json')
  const platform = JSON.parse(readFileSync(platformPath, 'utf8'))
  platform.platformConfig.importData = true
  platform.platformConfig.platformOverrides.core = {
    importmanager: { image: 'registry.example/importer:1' },
  }
  writeFileSync(platformPath, JSON.stringify(platform))
  const configPath = originalConfig.configPath
  const storedConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  storedConfig.components['core.importmanager'] = 'importManager'
  writeFileSync(configPath, JSON.stringify(storedConfig))
  const config = loadConfig(configPath, {})
  const importerImageId = 'id:registry.example/importer:1'
  let executeCalled = false
  class PlatformManager {
    constructor() {
      this.containers = new Map([['catalog-svc', { getId: () => 'container-catalog' }]])
    }
    hasValidatedConfig() {
      return true
    }
    async startContainers() {}
    async getPlatformInfo() {
      return { network: { id: 'platform-network' }, e2e: { baseUrl: 'https://app.example' } }
    }
    async exportPlatformInfo() {}
    async checkAllHealthy() {}
    getAllContainers() {
      return this.containers
    }
    async stopAllContainers() {}
  }
  const result = await runSingle(config, {
    env: {},
    runId: 'catalog-import',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: `id:${image}` }),
    docker: (args) => {
      if (args[0] === 'inspect' && args[2] === '{{.Image}}') return `id:registry.example/catalog:1`
      if (args[0] === 'ps') return 'importer-container'
      if (args[0] === 'inspect' && args[1] === 'importer-container') {
        return JSON.stringify([
          {
            Id: 'importer-container',
            Image: importerImageId,
            NetworkSettings: { Networks: { platform: { Aliases: ['importManager'] } } },
          },
        ])
      }
      if (args[0] === 'wait') return '0'
      if (args[0] === 'inspect' && args[2] === '{{json .State}}') {
        return JSON.stringify({ Status: 'exited', ExitCode: 0 })
      }
      return ''
    },
    executeImage: async () => {
      executeCalled = true
      return [{ success: true, status: 'success' }]
    },
  })
  assert.equal(result.status, 'success')
  assert.equal(executeCalled, true)
  const versions = JSON.parse(readFileSync(join(root, 'results', 'catalog-import', 'versions.json'), 'utf8'))
  assert.equal(versions.images['core.importmanager'].verified, true)
})

test('should stop before E2E when the importer exits unsuccessfully', async (t) => {
  const { root, config: originalConfig } = fixture(t)
  const platformPath = join(root, 'platform.json')
  const platform = JSON.parse(readFileSync(platformPath, 'utf8'))
  platform.platformConfig.importData = true
  platform.platformConfig.platformOverrides.core = {
    importmanager: { image: 'registry.example/importer:1' },
  }
  writeFileSync(platformPath, JSON.stringify(platform))
  const configPath = originalConfig.configPath
  const storedConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  storedConfig.components['core.importmanager'] = 'importManager'
  writeFileSync(configPath, JSON.stringify(storedConfig))
  const config = loadConfig(configPath, {})
  class PlatformManager {
    constructor() {
      this.containers = new Map([['catalog-svc', { getId: () => 'container-catalog' }]])
    }
    hasValidatedConfig() {
      return true
    }
    async startContainers() {}
    async getPlatformInfo() {
      return { network: { id: 'platform-network' }, e2e: { baseUrl: 'https://app.example' } }
    }
    async exportPlatformInfo() {}
    async checkAllHealthy() {}
    getAllContainers() {
      return this.containers
    }
    async stopAllContainers() {}
  }
  const result = await runSingle(config, {
    env: {},
    runId: 'catalog-import-failure',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: `id:${image}` }),
    docker: (args) => {
      if (args[0] === 'inspect' && args[2] === '{{.Image}}') return 'id:registry.example/catalog:1'
      if (args[0] === 'ps') return 'importer-container'
      if (args[0] === 'inspect' && args[1] === 'importer-container') {
        return JSON.stringify([
          {
            Id: 'importer-container',
            Image: `id:registry.example/importer:1`,
            NetworkSettings: { Networks: { platform: { Aliases: ['importManager'] } } },
          },
        ])
      }
      if (args[0] === 'wait') return '1'
      return ''
    },
    executeImage: async () => {
      throw new Error('E2E must not run when data import fails.')
    },
  })
  assert.equal(result.status, 'failure')
  assert.equal(result.failureStage, 'image-verification')
})

test('should honor an app-specific test base URL without changing platform URLs', async (t) => {
  const { root, config: initialConfig } = fixture(t)
  const configPath = initialConfig.configPath
  const source = JSON.parse(readFileSync(configPath, 'utf8'))
  source.test.baseUrl = 'https://catalog-ui:8443/catalog/'
  writeFileSync(configPath, JSON.stringify(source))
  const config = loadConfig(configPath, {})
  class PlatformManager {
    constructor() {
      this.containers = new Map([['catalog-svc', { getId: () => 'container-catalog' }]])
    }
    hasValidatedConfig() {
      return true
    }
    async startContainers() {}
    async getPlatformInfo() {
      return { network: { id: 'platform-network' }, e2e: { baseUrl: '', keycloakUrl: '' } }
    }
    async exportPlatformInfo() {}
    async checkAllHealthy() {}
    getAllContainers() {
      return this.containers
    }
    async stopAllContainers() {}
  }
  let observedBaseUrl
  const summary = await runSingle(config, {
    env: {},
    runId: 'catalog-base-url',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: `id:${image}` }),
    docker: () => `id:registry.example/catalog:1`,
    executeImage: async (options) => {
      observedBaseUrl = options.metadata.e2e.baseUrl
      options.onImageVerified()
      return [{ success: true, status: 'success' }]
    },
    generateRunReport: () => false,
  })
  assert.equal(summary.status, 'success')
  assert.equal(observedBaseUrl, 'https://catalog-ui:8443/catalog/')
})

test('should retain passing test status when Allure report generation fails', async (t) => {
  const { root, config } = fixture(t)
  class PlatformManager {
    constructor() {
      this.containers = new Map([['catalog-svc', { getId: () => 'container-catalog' }]])
    }
    hasValidatedConfig() {
      return true
    }
    async startContainers() {}
    async getPlatformInfo() {
      return { network: { id: 'platform-network' }, e2e: { baseUrl: 'https://app.example' } }
    }
    async exportPlatformInfo() {}
    async checkAllHealthy() {}
    getAllContainers() {
      return this.containers
    }
    async stopAllContainers() {}
  }
  const summary = await runSingle(config, {
    env: {},
    runId: 'catalog-report-failure',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: `id:${image}` }),
    docker: () => 'id:registry.example/catalog:1',
    executeImage: async (options) => {
      options.onImageVerified()
      return [{ success: true, status: 'success' }]
    },
    generateRunReport: () => {
      throw new Error('Allure unavailable')
    },
  })
  assert.equal(summary.status, 'failure')
  assert.equal(summary.failureStage, 'report')
  const publicSummary = JSON.parse(readFileSync(join(root, 'results', 'catalog-report-failure', 'summary.json'), 'utf8'))
  assert.equal(publicSummary.testStatus, 'success')
  assert.equal(publicSummary.allureReportStatus, 'failure')
  assert.equal(publicSummary.e2eAggregate.finalStatus, 'success')
})

test('should mark test status as failed when the E2E executor throws', async (t) => {
  const { root, config } = fixture(t)
  let cleanupCalled = false
  class PlatformManager {
    constructor() {
      this.containers = new Map([['catalog-svc', { getId: () => 'container-catalog' }]])
    }
    hasValidatedConfig() {
      return true
    }
    async startContainers() {}
    async getPlatformInfo() {
      return { network: { id: 'platform-network' }, e2e: { baseUrl: 'https://app.example' } }
    }
    async exportPlatformInfo() {}
    async checkAllHealthy() {}
    getAllContainers() {
      return this.containers
    }
    async stopAllContainers() {
      cleanupCalled = true
    }
  }
  const summary = await runSingle(config, {
    env: {},
    runId: 'catalog-e2e-failure',
    results: join(root, 'results'),
    work: join(root, 'work'),
    platform: { PlatformManager },
    resolveImage: (image) => ({ requested: image, resolved: image, imageId: `id:${image}` }),
    docker: () => 'id:registry.example/catalog:1',
    executeImage: async () => {
      throw new Error('E2E runtime contract is invalid.')
    },
  })
  assert.equal(summary.status, 'failure')
  assert.equal(summary.testStatus, 'failure')
  assert.equal(summary.allureReportStatus, 'not-generated')
  assert.equal(cleanupCalled, true)
})

test('should record a failed image resolution in version provenance', async (t) => {
  const { root, config } = fixture(t)
  const summary = await runSingle(config, {
    env: {},
    runId: 'catalog-image-resolution',
    results: join(root, 'results'),
    work: join(root, 'work'),
    resolveImage: () => {
      throw new Error('registry not reachable')
    },
  })
  assert.equal(summary.status, 'failure')
  const resultsDir = join(root, 'results', 'catalog-image-resolution')
  const versions = JSON.parse(readFileSync(join(resultsDir, 'versions.json'), 'utf8'))
  const storedSummary = JSON.parse(readFileSync(join(resultsDir, 'summary.json'), 'utf8'))
  assert.equal(versions.images['services.catalog'].status, 'resolution-failed')
  assert.equal(storedSummary.imageStatus.status, 'failure')
})
