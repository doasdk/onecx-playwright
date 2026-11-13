export const runtimeContractLabel = 'org.onecx.playwright.contract'

export function executionContract(labels = {}) {
  const version = labels[runtimeContractLabel]
  if (version === undefined || version === null) return 'legacy'
  if (version !== '1') throw new Error(`Unsupported OneCX runtime contract version: ${version}`)
  return '1'
}

export function runtimeEnvelope({ metadata, environments, data, environment, script, capture }) {
  return {
    version: 1,
    script,
    config: 'playwright.config.ts',
    environment: {
      CI: 'true',
      ENV: environment,
      ENVIRONMENTS_JSON: JSON.stringify(environments),
      TEST_DATA_JSON: JSON.stringify(data),
      BASE_URL: metadata.e2e.baseUrl,
      PLATFORM_INFO_JSON: JSON.stringify(metadata),
      TLS_CA_CERT_PATH: '/tmp/onecx-ca.pem',
      OUTPUT_DIR: '/e2e-results',
      CAPTURE_PRIVATE_ARTIFACTS: String(capture),
    },
  }
}

export function executionStatus(exitCode, timedOut, manifest, contract) {
  if (timedOut) return 'timeout'
  if (contract === 'legacy') return exitCode === 0 ? 'success' : 'failed'
  if (
    manifest?.version !== 1 ||
    !['success', 'test-failed', 'configuration-failed', 'interrupted'].includes(manifest.status) ||
    manifest.exitCode !== exitCode ||
    (manifest.status === 'success') !== (exitCode === 0)
  ) {
    throw new Error('E2E runtime did not produce a valid execution manifest matching its container exit status.')
  }
  return manifest.status
}

export function executionFailureStage(records) {
  if (records.some((record) => record.status === 'configuration-failed')) return 'e2e-configuration'
  if (records.some((record) => record.status === 'timeout')) return 'e2e-timeout'
  if (records.some((record) => record.status === 'interrupted')) return 'interrupted'
  return 'e2e'
}
