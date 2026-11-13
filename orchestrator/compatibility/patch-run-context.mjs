import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertSupportedIntegrationVersion } from './supported-version.mjs'

export function patchRunContext(source) {
  const original = 'const runDir = (0, artifacts_1.resolveRunArtifactsDir)(root, effectiveRunId);'
  const replacement =
    "const runDir = root === undefined && process.env.E2E_BASE_DIR?.trim() ? path.resolve(process.env.E2E_BASE_DIR) : (0, artifacts_1.resolveRunArtifactsDir)(root, effectiveRunId);"
  if (source.includes(replacement) && !source.includes(original)) return source
  if (source.split(original).length !== 2 || source.includes(replacement)) {
    throw new Error('Unexpected run-context implementation. Refusing to apply output path patch.')
  }
  return source.replace(original, replacement)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('@onecx/integration-tests'))
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assertSupportedIntegrationVersion(metadata.version)
  const file = join(packageRoot, 'lib', 'utils', 'run-context.js')
  const source = readFileSync(file, 'utf8')
  const patched = patchRunContext(source)
  if (patched !== source) writeFileSync(file, patched)
  console.log('Run-context patch active: exported platform metadata and CA honor E2E_BASE_DIR.')
}
