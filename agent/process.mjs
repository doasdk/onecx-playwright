import { spawn, execFile } from 'node:child_process'

export const PROCESS_DIAGNOSTICS = Object.freeze({
  tls: 'Agent TLS certificate validation failed; check the configured model CA trust.',
  auth: 'Agent model authentication or authorization failed; check credentials and permissions.',
  model: 'Agent model or endpoint was rejected; check the configured model and API endpoint.',
  network: 'Agent model connection failed; check network connectivity and service availability.',
  rate: 'Agent model rate or quota limit was reached; check capacity and billing.',
  cli: 'Agent CLI arguments were rejected; check installed CLI compatibility.',
  mcp: 'Agent MCP server startup failed; check browser MCP configuration and dependencies.',
  compatibility: 'Agent structured-output or tool-use compatibility failed; check model and API compatibility.'
})

const diagnosticPatterns = [
  ['tls', /\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)\b|unable to verify (?:the first|leaf) certificate|self[- ]signed certificate|certificate (?:verify failed|has expired)/i],
  ['auth', /\b(?:authentication_error|permission_error)\b|API Error:\s*(?:401|403)\b|invalid (?:API key|authentication credentials)|authentication failed/i],
  ['rate', /\b(?:rate_limit_error|insufficient_quota)\b|API Error:\s*429\b|rate limit exceeded|credit balance is too low|quota exceeded/i],
  ['model', /API Error:\s*404\b|\bnot_found_error\b|(?:unknown|invalid|unsupported) model\b|model\b[^\r\n]{0,160}\b(?:not found|does not exist|not available)|(?:unknown|unsupported) (?:API )?endpoint/i],
  ['compatibility', /(?:response_format|json_schema|structured[_ -]outputs?|tool_choice|tool_use|tool_result)\b[^\r\n]{0,160}\b(?:not supported|unsupported|not permitted|not allowed)|(?:unsupported|unknown) (?:parameter|field)[^\r\n]{0,80}\b(?:response_format|json_schema|tools|tool_choice)\b|tool_use[^\r\n]{0,160}without[^\r\n]{0,80}tool_result/i],
  ['cli', /(?:unknown|unrecognized|unexpected|bad) (?:option|argument):?\s+['"]?--|option\b[^\r\n]{0,100}argument missing|requires? (?:an? )?argument\b/i],
  ['mcp', /failed to (?:connect to|start|launch) (?:the )?MCP server|MCP server\b[^\r\n]{0,160}(?:failed to (?:start|connect)|startup failed|connection failed)/i],
  ['network', /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b|(?:^|\n)(?:Error:\s*)?(?:Connection error|Request timed out|fetch failed)\.?[ \t]*(?:\r?\n|$)/i]
]

function classifyFailure(stdout, stderr) {
  let resultMessage = ''
  let structuredOutputFailure = false
  try {
    // Only the final error envelope is diagnostic evidence, never browser/tool transcript text.
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    if (result?.type === 'result' &&
        (result.is_error === true || /^error_/.test(result.subtype))) {
      structuredOutputFailure = result.subtype === 'error_max_structured_output_retries'
      resultMessage = [
        typeof result.result === 'string' ? result.result : '',
        ...(Array.isArray(result.errors) ? result.errors.filter((value) => typeof value === 'string') : [])
      ].join('\n')
    }
  } catch {
    // Non-JSON stdout is intentionally not used for classification.
  }
  for (const source of [stderr, resultMessage]) {
    for (const [category, pattern] of diagnosticPatterns) {
      if (pattern.test(source)) return PROCESS_DIAGNOSTICS[category]
    }
  }
  return structuredOutputFailure
    ? PROCESS_DIAGNOSTICS.compatibility
    : 'Agent process did not complete successfully.'
}

function stopTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

export function runProcess(
  command,
  args,
  { env, cwd, input = '', signal, maxBytes = 1_048_576, spawnProcess = spawn }
) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const child = spawnProcess(command, args, {
      env,
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let output = ''
    let diagnostics = ''
    let bytes = 0
    let failure
    const abort = () => {
      failure = new Error('Agent execution was interrupted.')
      stopTree(child)
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => {
      signal?.removeEventListener('abort', abort)
      reject(new Error('Cannot start the installed agent process.'))
    })
    child.stdin.on('error', () => {})
    for (const [stream, capture] of [
      [child.stdout, true],
      [child.stderr, false]
    ]) {
      stream.on('data', (data) => {
        bytes += data.length
        if (bytes > maxBytes) {
          failure = new Error('Agent output budget exceeded.')
          stopTree(child)
        } else if (capture) output += data.toString('utf8')
        else diagnostics += data.toString('utf8')
      })
    }
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      // Kill the isolated process group even when the CLI left an MCP child behind.
      stopTree(child)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(classifyFailure(output, diagnostics)))
      else resolve(output)
    })
    if (signal?.aborted) abort()
    child.stdin.end(input)
  })
}
