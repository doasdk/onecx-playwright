import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const configError = () => new Error('AGENT_CONFIG_JSON must contain a valid agent configuration.')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key))

export function validateAgentConfig(value) {
  if (!isObject(value) ||
      !exactKeys(value, ['anthropicBaseUrl', 'model', 'authToken', 'apiKey', 'extraCaCertPem']) ||
      !text(value.anthropicBaseUrl) || typeof value.model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value.model) ||
      (Object.hasOwn(value, 'authToken') === Object.hasOwn(value, 'apiKey')) ||
      !text(value.authToken ?? value.apiKey) ||
      /[\r\n\0]/.test(value.authToken ?? value.apiKey) ||
      (Object.hasOwn(value, 'extraCaCertPem') &&
        (!text(value.extraCaCertPem) ||
          !value.extraCaCertPem.includes('-----BEGIN CERTIFICATE-----') ||
          !value.extraCaCertPem.includes('-----END CERTIFICATE-----')))) throw configError()
  let url
  try {
    url = new URL(value.anthropicBaseUrl)
  } catch {
    throw configError()
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw configError()
  return value
}

export function readAgentConfig(env, directory) {
  const value = env.AGENT_CONFIG_JSON
  const file = env.AGENT_CONFIG_JSON_FILE
  if (!value && !file) return undefined
  if (value && file) throw configError()
  try {
    const raw = value || readFileSync(resolve(directory, file), 'utf8')
    validateAgentConfig(JSON.parse(raw))
    return raw
  } catch {
    throw configError()
  }
}

export function exportAgentReport(source, target, agentConfig) {
  if (!existsSync(source)) return false
  try {
    const stat = lstatSync(source)
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error()
    const report = JSON.parse(readFileSync(source, 'utf8'))
    const verdicts = ['passed', 'failed', 'inconclusive']
    if (!isObject(report) || !exactKeys(report, ['schemaVersion', 'verdict', 'summary', 'checks']) ||
        report.schemaVersion !== 1 || !verdicts.includes(report.verdict) ||
        typeof report.summary !== 'string' || !Array.isArray(report.checks) ||
        !report.checks.every((check) => isObject(check) &&
          exactKeys(check, ['name', 'verdict', 'evidence']) &&
          text(check.name) && verdicts.includes(check.verdict) && typeof check.evidence === 'string')) {
      throw new Error()
    }
    const config = agentConfig ? validateAgentConfig(JSON.parse(agentConfig)) : {}
    const secrets = [config.authToken, config.apiKey, config.extraCaCertPem].filter(Boolean)
    const redact = (value) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value)
    const safe = {
      schemaVersion: 1,
      verdict: report.verdict,
      summary: redact(report.summary),
      checks: report.checks.map((check) => ({
        name: redact(check.name),
        verdict: check.verdict,
        evidence: redact(check.evidence),
      })),
    }
    writeFileSync(target, JSON.stringify(safe, null, 2), { mode: 0o600 })
    return true
  } catch {
    throw new Error('Agent report is invalid or could not be exported.')
  }
}
