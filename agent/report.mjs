import { redact } from './security.mjs'

const verdicts = ['passed', 'failed', 'inconclusive']
const text = { type: 'string', minLength: 1, maxLength: 4000 }
export const reportSchema = (requiredChecks) => ({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'verdict', 'summary', 'checks'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    verdict: { type: 'string', enum: verdicts },
    summary: text,
    checks: {
      type: 'array',
      minItems: requiredChecks.length,
      maxItems: requiredChecks.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'verdict', 'evidence'],
        properties: {
          name: { type: 'string', enum: requiredChecks },
          verdict: { type: 'string', enum: verdicts },
          evidence: text
        }
      }
    }
  }
})

export function validateResult(raw, requiredChecks, requiredTools, secrets = []) {
  let events
  try {
    events = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line))
  } catch {
    throw new Error('Agent returned invalid JSON.')
  }
  const envelope = events.at(-1)
  const connected = events.some((event) =>
    event.type === 'system' &&
    event.subtype === 'init' &&
    event.mcp_servers?.some((server) => server.name === 'browser' && server.status === 'connected')
  )
  const calls = new Map()
  const successful = new Set()
  for (const event of events) {
    if (event.type === 'assistant') {
      for (const block of event.message?.content || []) {
        if (block.type === 'tool_use' && typeof block.id === 'string' &&
            requiredTools.some((name) => block.name === `mcp__browser__${name}`)) {
          calls.set(block.id, block.name)
        }
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content || []) {
        if (block.type !== 'tool_result' || block.is_error === true || event.tool_use_result?.isError === true ||
            !calls.has(block.tool_use_id)) continue
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (!content || /(?:###\s*Error\b|"isError"\s*:\s*true|<tool_use_error>|^Error:)/i.test(content)) continue
        successful.add(calls.get(block.tool_use_id))
      }
    }
  }
  if (!connected || requiredTools.some((name) => !successful.has(`mcp__browser__${name}`))) {
    throw new Error('Required browser tools were not successfully observed.')
  }
  const report = envelope?.structured_output
  const validText = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000
  const exactKeys = (value, keys) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join()
  if (
    envelope.is_error === true ||
    envelope.type !== 'result' ||
    envelope.subtype !== 'success' ||
    !exactKeys(report, ['schemaVersion', 'verdict', 'summary', 'checks']) ||
    report.schemaVersion !== 1 ||
    !verdicts.includes(report.verdict) ||
    !validText(report.summary) ||
    !Array.isArray(report.checks) ||
    report.checks.length !== requiredChecks.length ||
    report.checks.some(
      (check) =>
        !exactKeys(check, ['name', 'verdict', 'evidence']) ||
        !requiredChecks.includes(check.name) ||
        !verdicts.includes(check.verdict) ||
        !validText(check.evidence)
    ) ||
    new Set(report.checks.map((check) => check.name)).size !== requiredChecks.length
  ) {
    throw new Error('Agent result does not match the required report contract.')
  }
  const expected = report.checks.some((check) => check.verdict === 'failed')
    ? 'failed'
    : report.checks.some((check) => check.verdict === 'inconclusive')
      ? 'inconclusive'
      : 'passed'
  if (report.verdict !== expected) throw new Error('Agent verdict is inconsistent with its checks.')
  return {
    schemaVersion: 1,
    verdict: report.verdict,
    summary: redact(report.summary, secrets),
    checks: report.checks.map((check) => ({ ...check, evidence: redact(check.evidence, secrets) }))
  }
}

export function failureReport(summary, requiredChecks = []) {
  return {
    schemaVersion: 1,
    verdict: 'inconclusive',
    summary,
    checks: requiredChecks.map((name) => ({
      name,
      verdict: 'inconclusive',
      evidence: 'Not verified by a completed agent run.'
    }))
  }
}
