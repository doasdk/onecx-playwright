import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { assertSupportedIntegrationVersion } from './supported-version.mjs'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('@onecx/integration-tests'))
const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
assertSupportedIntegrationVersion(metadata.version)

const file = join(packageRoot, 'lib', 'containers', 'core', 'onecx-keycloak.js')
const source = readFileSync(file, 'utf8')
const realmFile = join(packageRoot, 'assets', 'keycloak', 'realm-onecx.json')
const realmSource = readFileSync(realmFile, 'utf8')
const realm = JSON.parse(realmSource)
if (
  realm.realm !== 'onecx' ||
  !realm.attributes ||
  (Object.hasOwn(realm.attributes, 'frontendUrl') && realm.attributes.frontendUrl !== 'http://keycloak-app:8080')
) {
  throw new Error('Unexpected Keycloak realm frontend URL. Refusing to apply compatibility patch.')
}
let patchedRealm = realmSource
if (Object.hasOwn(realm.attributes, 'frontendUrl')) {
  const override = '    "frontendUrl": "http://keycloak-app:8080",'
  if (realmSource.split(override).length - 1 !== 1) {
    throw new Error('Unexpected Keycloak realm format. Refusing to apply compatibility patch.')
  }
  // Let KC_HOSTNAME define the browser-facing URLs instead of this stale HTTP override.
  patchedRealm = realmSource.replace(override, '')
  JSON.parse(patchedRealm)
}
// Slow CI runners need about 4+ minutes for Keycloak augmentation, schema creation and realm import.
const command = ".withCommand(['start-dev', '--import-realm']).withNetworkAliases('keycloak-app')"
const probe = '            interval: 10_000,\n            timeout: 5_000,\n'
const changes = [
  {
    // Original package code, then the previous patch version (kept so already patched installs upgrade cleanly).
    before: [`${command}.withStartupTimeout(120_000);`, `${command}.withStartupTimeout(300_000);`],
    after: `${command}.withStartupTimeout(900_000);`
  },
  {
    before: [`${probe}            retries: 10,`, `${probe}            startPeriod: 120_000,\n            retries: 12,`],
    after: `${probe}            startPeriod: 480_000,\n            retries: 30,`
  }
]
let patched = source.replace(/\r\n/g, '\n')
const count = (text) => patched.split(text).length - 1
const states = changes.map(({ before, after }) => {
  const matches = before.filter((text) => count(text) === 1)
  if (count(after) === 1 && matches.length === 0) return 'applied'
  if (count(after) === 0 && matches.length === 1 && before.every((text) => count(text) <= 1)) return matches[0]
  throw new Error('Unexpected Keycloak implementation. Refusing to apply startup patch.')
})
if (states.some((state) => state === 'applied') && !states.every((state) => state === 'applied')) {
  throw new Error('Partially applied Keycloak startup patch. Restore dependencies with npm ci.')
}
if (!states.every((state) => state === 'applied')) {
  changes.forEach(({ after }, index) => {
    patched = patched.replace(states[index], after)
  })
  writeFileSync(file, patched)
}
if (patchedRealm !== realmSource) writeFileSync(realmFile, patchedRealm)
console.log(
  'Keycloak startup patch active: timeout=900s, startPeriod=480s, interval=10s, check timeout=5s, retries=30.'
)
console.log('Keycloak realm patch active: browser URLs inherit HTTPS KC_HOSTNAME; stale HTTP frontendUrl removed.')
