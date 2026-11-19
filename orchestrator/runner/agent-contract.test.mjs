import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportAgentReport, readAgentConfig, validateAgentConfig } from './agent-contract.mjs'

const config = { anthropicBaseUrl: 'https://model-gateway.example/anthropic', model: 'test-model', authToken: 'secret-token' }
const report = { schemaVersion: 1, verdict: 'passed', summary: 'Complete', checks: [
  { name: 'Navigation', verdict: 'passed', evidence: 'Page loaded' },
] }

function fixture(t) {
  const root = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.agent-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, source: join(root, 'input.json'), target: join(root, 'agent-report.json') }
}

test('should preserve absent agent configuration', () => {
  assert.equal(readAgentConfig({}, '.'), undefined)
  assert.equal(readAgentConfig({ AGENT_CONFIG_JSON: '' }, '.'), undefined)
})

test('should preserve valid inline configuration verbatim', () => {
  const raw = JSON.stringify(config, null, 2)
  assert.equal(readAgentConfig({ AGENT_CONFIG_JSON: raw }, '.'), raw)
})

test('should load agent configuration from its private file', (t) => {
  const { root, source } = fixture(t)
  writeFileSync(source, JSON.stringify(config))
  assert.equal(readAgentConfig({ AGENT_CONFIG_JSON_FILE: 'input.json' }, root), JSON.stringify(config))
})

for (const value of [
  null, [], {}, { ...config, extra: 'private' }, { ...config, authToken: '' },
  { ...config, authToken: null }, { ...config, apiKey: 'other-secret' },
  { ...config, model: '\0' }, { ...config, extraCaCertPem: '' },
  { ...config, anthropicBaseUrl: 'not-a-url' },
  { ...config, anthropicBaseUrl: 'http://remote.example' },
  { ...config, anthropicBaseUrl: 'https://user:password@example.com' },
  { ...config, anthropicBaseUrl: 'https://example.com/#secret' },
]) {
  test(`should reject invalid config case ${JSON.stringify(value).replaceAll('secret', 'redacted')}`, () => {
    assert.throws(() => validateAgentConfig(value), /^Error: AGENT_CONFIG_JSON must contain a valid agent configuration\.$/)
  })
}

test('should reject local HTTP model endpoints when credentials would be sent without HTTPS', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const value = { anthropicBaseUrl: `http://${host}:8080`, model: 'test', apiKey: 'key' }
    assert.throws(() => validateAgentConfig(value), /valid agent configuration/)
  }
})

test('should permit API key authentication when model endpoint uses HTTPS', () => {
  const value = {
    anthropicBaseUrl: 'https://model.example/api', model: 'test', apiKey: 'key',
    extraCaCertPem: '-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----'
  }
  assert.equal(validateAgentConfig(value), value)
})

for (const value of [
  { ...config, anthropicBaseUrl: 'https://model.example?token=private' },
  { ...config, model: '--unsafe' },
  { ...config, authToken: 'line\nbreak' },
  { ...config, extraCaCertPem: 'pem' }
]) {
  test('should reject provider configuration when shared runner would reject the same value', () => {
    assert.throws(() => validateAgentConfig(value), /valid agent configuration/)
  })
}

for (const env of [
  { AGENT_CONFIG_JSON: 'private-invalid-json' },
  { AGENT_CONFIG_JSON: '{}', AGENT_CONFIG_JSON_FILE: 'private-path' },
  { AGENT_CONFIG_JSON_FILE: 'private-nonexistent-file' },
]) {
  test('should redact configuration errors when a source is invalid or ambiguous', () => {
    assert.throws(() => readAgentConfig(env, '.'), /^Error: AGENT_CONFIG_JSON must contain a valid agent configuration\.$/)
  })
}

test('should preserve missing report behavior', (t) => {
  const { source, target } = fixture(t)
  assert.equal(exportAgentReport(source, target), false)
  assert.equal(existsSync(target), false)
})

test('should export only the validated public report', (t) => {
  const { source, target } = fixture(t)
  writeFileSync(source, JSON.stringify(report))
  assert.equal(exportAgentReport(source, target), true)
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), report)
})

test('should redact known agent credentials from every free-text field', (t) => {
  const { source, target } = fixture(t)
  const pem = '-----BEGIN CERTIFICATE-----\nprivate-pem\n-----END CERTIFICATE-----'
  writeFileSync(source, JSON.stringify({
    ...report, summary: `secret-token ${pem}`,
    checks: [{ name: 'secret-token', verdict: 'inconclusive', evidence: `${pem} secret-token` }],
  }))
  exportAgentReport(source, target, JSON.stringify({ ...config, extraCaCertPem: pem }))
  assert.doesNotMatch(readFileSync(target, 'utf8'), /secret-token|private-pem/)
})

for (const value of [
  null, [], {}, { ...report, authToken: 'private' }, { ...report, schemaVersion: 2 },
  { ...report, verdict: 'unknown' }, { ...report, summary: {} }, { ...report, checks: {} },
  { ...report, checks: [null] }, { ...report, checks: [{ ...report.checks[0], transcript: 'private' }] },
  { ...report, checks: [{ ...report.checks[0], name: '' }] },
  { ...report, checks: [{ ...report.checks[0], verdict: 'unknown' }] },
  { ...report, checks: [{ ...report.checks[0], evidence: {} }] },
]) {
  test('should reject unsafe report shapes without creating a public file', (t) => {
    const { source, target } = fixture(t)
    writeFileSync(source, JSON.stringify(value))
    assert.throws(() => exportAgentReport(source, target), /^Error: Agent report is invalid or could not be exported\.$/)
    assert.equal(existsSync(target), false)
  })
}

for (const content of ['private-invalid-json', 'x'.repeat(1_048_577)]) {
  test('should reject malformed or oversized reports without exposing raw contents', (t) => {
    const { source, target } = fixture(t)
    writeFileSync(source, content)
    assert.throws(() => exportAgentReport(source, target), /Agent report is invalid/)
    assert.equal(existsSync(target), false)
  })
}

test('should reject a directory in place of a report', (t) => {
  const { source, target } = fixture(t)
  mkdirSync(source)
  assert.throws(() => exportAgentReport(source, target), /Agent report is invalid/)
})

test('should reject a symbolic link in place of a report', { skip: process.platform === 'win32' }, (t) => {
  const { root, source, target } = fixture(t)
  const real = join(root, 'real.json')
  writeFileSync(real, JSON.stringify(report))
  symlinkSync(real, source)
  assert.throws(() => exportAgentReport(source, target), /Agent report is invalid/)
})
