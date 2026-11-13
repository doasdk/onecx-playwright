import { readFileSync } from 'node:fs'

export const supportedIntegrationVersion = JSON.parse(
  readFileSync(new URL('./compatibility.json', import.meta.url), 'utf8')
).integrationTests

export function assertSupportedIntegrationVersion(version) {
  if (version !== supportedIntegrationVersion) {
    throw new Error(
      `Compatibility adapters support @onecx/integration-tests ${supportedIntegrationVersion} only; found ${version}; review adapters and update compatibility baseline after verifying`
    )
  }
}
