const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const input = JSON.parse(fs.readFileSync('/tmp/onecx-runtime.json', 'utf8'))
fs.mkdirSync('/e2e-results', { recursive: true })
const result = spawnSync('npm', ['run', input.script], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CI: 'true',
    ENV: input.environment,
    ENVIRONMENTS_JSON: JSON.stringify(input.environments),
    TEST_DATA_JSON: JSON.stringify(input.data),
    ONECX_RUNTIME_FILE: '/tmp/onecx-runtime.json',
    OUTPUT_DIR: '/e2e-results',
    BASE_URL: input.metadata.e2e.baseUrl,
    TLS_CA_CERT_PATH: '/tmp/onecx-ca.pem',
    NODE_EXTRA_CA_CERTS: '/tmp/onecx-ca.pem',
    PLATFORM_INFO_JSON: JSON.stringify(input.metadata),
    CAPTURE_PRIVATE_ARTIFACTS: String(input.capture),
  },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
