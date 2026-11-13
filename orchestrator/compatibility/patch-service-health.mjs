import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { assertSupportedIntegrationVersion } from './supported-version.mjs'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('@onecx/integration-tests'))
const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
assertSupportedIntegrationVersion(metadata.version)

function replaceOnce(source, original, replacement, description) {
  const beforeCount = source.split(original).length - 1
  const afterCount = source.split(replacement).length - 1
  if (beforeCount === 1 && afterCount === 0) {
    return source.replace(original, replacement)
  }
  if (beforeCount === 0 && afterCount === 1) {
    return source
  }
  throw new Error(`Unexpected ${description}. Refusing to apply service health patch.`)
}

const updates = ['svc', 'bff'].map((kind) => {
  const file = join(packageRoot, 'lib', 'containers', 'basic', `onecx-${kind}.js`)
  let source = readFileSync(file, 'utf8')
  const defaultProbe = kind === 'svc' ? 'DEFAULT_COMMAND_HEALTH_CHECK' : 'DEFAULT_COMMAND_HEALTH_CHECK(this.port)'
  const original = [
    `        const effectiveCommandHC = this.commandHealthCheckConfig ?? (hasCustomConfig ? undefined : ${defaultProbe});`,
    '        if (effectiveCommandHC) {',
    '            this.withHealthCheck((0, wait_strategy_utils_1.toTestcontainersHealthCheck)(effectiveCommandHC));',
    '        }',
    '        const waitStrategies = (0, wait_strategy_utils_1.buildWaitStrategies)(effectiveCommandHC, this.healthCheckConfigs);'
  ].join('\n')
  const replacement = [
    '        const effectiveCommandHC = this.commandHealthCheckConfig;',
    '        if (effectiveCommandHC) {',
    '            this.withHealthCheck((0, wait_strategy_utils_1.toTestcontainersHealthCheck)(effectiveCommandHC));',
    '        } else if (!hasCustomConfig) {',
    "            this.withHealthCheck({ test: ['NONE'] });",
    '        }',
    '        const waitStrategies = hasCustomConfig',
    '            ? (0, wait_strategy_utils_1.buildWaitStrategies)(effectiveCommandHC, this.healthCheckConfigs)',
    "            : [testcontainers_1.Wait.forHttp('/q/health', this.port, { abortOnContainerExit: true }).forStatusCode(200).withReadTimeout(5000)];"
  ].join('\n')
  source = replaceOnce(source, original, replacement, `${kind} startup implementation`)
  if (kind === 'bff') {
    source = replaceOnce(
      source,
      '        this.withExposedPorts(this.port).withWaitStrategy(testcontainers_1.Wait.forAll([...waitStrategies, testcontainers_1.Wait.forListeningPorts()]));',
      '        this.withExposedPorts(this.port).withWaitStrategy(testcontainers_1.Wait.forAll(hasCustomConfig ? [...waitStrategies, testcontainers_1.Wait.forListeningPorts()] : waitStrategies));',
      'BFF port wait implementation'
    )
  }
  source = replaceOnce(
    source,
    '    getHealthCheckExecutor() {\n        if (!this.commandHealthCheck) {',
    [
      '    getHealthCheckExecutor() {',
      '        if (!this.commandHealthCheck && this.healthCheckConfigs.length === 0) {',
      '            const host = this.getHost();',
      "            const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;",
      '            const endpoint = `http://${authority}:${this.getMappedPort(this.port)}/q/health`;',
      '            return new health_check_executor_1.HttpHealthCheckExecutor(endpoint, 5000, [200]);',
      '        }',
      '        if (!this.commandHealthCheck) {'
    ].join('\n'),
    `${kind} ongoing health implementation`
  )
  return { file, source }
})

// Validate every target before changing either installed module.
for (const { file, source } of updates) {
  writeFileSync(file, source)
}
console.log(
  'Service/BFF health patch active: Node-side GET /q/health requires HTTP 200 at startup and during ongoing checks; no in-image curl required. Custom probes unchanged.'
)
