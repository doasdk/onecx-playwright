import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROCESS_DIAGNOSTICS, runProcess } from './process.mjs'
import { EventEmitter } from 'node:events'

test('should capture stdout without returning stderr when subprocess succeeds', async () => {
  const output = await runProcess(
    process.execPath,
    ['-e', 'process.stdin.resume(); process.stdout.write("safe"); process.stderr.write("private")'],
    { env: process.env, input: 'test input' }
  )
  assert.equal(output, 'safe')
})

test('should reject without raw output when subprocess exits nonzero', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stderr.write("private"); process.exit(2)'], { env: process.env }),
    { message: 'Agent process did not complete successfully.' }
  )
})

test('should return safe startup error when executable is missing', async () => {
  await assert.rejects(runProcess('definitely-not-an-installed-agent-executable', [], { env: process.env }), {
    message: 'Cannot start the installed agent process.'
  })
})

test('should release cancellation listener when executable startup fails', async () => {
  const controller = new AbortController()
  await assert.rejects(runProcess('definitely-not-an-installed-agent-executable', [], {
    env: process.env, signal: controller.signal
  }), { message: 'Cannot start the installed agent process.' })
})

for (const stream of ['stdout', 'stderr']) {
  test(`should terminate subprocess when ${stream} exceeds output budget`, async () => {
    await assert.rejects(
      runProcess(process.execPath, ['-e', `process.${stream}.write("x".repeat(8192)); setInterval(()=>{},1000)`], {
        env: process.env,
        maxBytes: 100
      }),
      { message: 'Agent output budget exceeded.' }
    )
  })
}

test('should terminate subprocess when execution is aborted', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: process.env, signal: controller.signal }),
      { message: 'Agent execution was interrupted.' }
    )
  } finally {
    clearTimeout(timer)
  }
})

test('should not start a child when already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  let started = false
  await assert.rejects(
    runProcess('unused', [], {
      signal: controller.signal,
      spawnProcess: () => {
        started = true
      }
    })
  )
  assert.equal(started, false)
})

function fakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdin = new EventEmitter()
  child.stdin.end = () => {}
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

const privateDetails = 'Bearer super-private-token https://private-model.example/api?key=secret'
const classificationCases = [
  ['tls', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
  ['tls', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],
  ['tls', 'SELF_SIGNED_CERT_IN_CHAIN'],
  ['tls', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
  ['tls', 'CERT_HAS_EXPIRED'],
  ['tls', 'ERR_TLS_CERT_ALTNAME_INVALID'],
  ['tls', 'unable to verify the first certificate'],
  ['tls', 'self-signed certificate in certificate chain'],
  ['auth', 'API Error: 401 unauthorized'],
  ['auth', 'API Error: 403 forbidden'],
  ['auth', '{"type":"authentication_error","message":"private"}'],
  ['auth', 'Invalid API key'],
  ['model', 'API Error: 404 not found'],
  ['model', 'Unknown model'],
  ['model', 'The model requested does not exist'],
  ['model', 'Unsupported API endpoint'],
  ['network', 'connect ECONNREFUSED'],
  ['network', 'getaddrinfo ENOTFOUND'],
  ['network', 'EAI_AGAIN'],
  ['network', 'ETIMEDOUT'],
  ['network', 'ECONNRESET'],
  ['network', 'UND_ERR_CONNECT_TIMEOUT'],
  ['network', 'Connection error.'],
  ['network', 'Error: Request timed out.'],
  ['network', 'fetch failed'],
  ['rate', 'API Error: 429 rate limited'],
  ['rate', 'rate_limit_error'],
  ['rate', 'insufficient_quota'],
  ['rate', 'Your credit balance is too low'],
  ['cli', "error: unknown option '--bare'"],
  ['cli', 'node: bad option: --bare'],
  ['cli', "error: option '--model <model>' argument missing"],
  ['mcp', 'Failed to connect to MCP server browser'],
  ['mcp', 'MCP server browser failed to start'],
  ['compatibility', 'response_format is not supported'],
  ['compatibility', 'Unsupported parameter: tools'],
  ['compatibility', 'tool_use ids were found without tool_result blocks']
]

for (const [category, diagnostic] of classificationCases) {
  for (const source of ['stderr', 'result']) {
    test(`should return only the static ${category} diagnostic when ${source} contains ${diagnostic}`, async () => {
      const child = fakeChild()
      const promise = runProcess('unused', [], { spawnProcess: () => child })
      const message = `${diagnostic}\n${privateDetails}`
      if (source === 'stderr') child.stderr.emit('data', Buffer.from(message))
      else child.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result', subtype: 'error_during_execution', is_error: true, errors: [message, { message }, null]
      })))
      child.emit('close', 1)
      await assert.rejects(promise, (error) => {
        assert.equal(error.message, PROCESS_DIAGNOSTICS[category])
        assert.doesNotMatch(error.stack, /super-private-token|private-model\.example|key=secret/)
        assert.deepEqual(Object.keys(error), [])
        return true
      })
    })
  }
}

for (const result of [
  { type: 'result', is_error: true, result: 'API Error: 401 private' },
  { type: 'result', subtype: 'error_during_execution', errors: ['authentication_error'] }
]) {
  test(`should classify final result errors when using ${JSON.stringify(result)}`, async () => {
    const child = fakeChild()
    const promise = runProcess('unused', [], { spawnProcess: () => child })
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(result)}\r\n`))
    child.emit('close', 1)
    await assert.rejects(promise, { message: PROCESS_DIAGNOSTICS.auth })
  })
}

test('should classify compatibility when the CLI exhausts structured output retries', async () => {
  const child = fakeChild()
  const promise = runProcess('unused', [], { spawnProcess: () => child })
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'result', subtype: 'error_max_structured_output_retries', errors: []
  })))
  child.emit('close', 1)
  await assert.rejects(promise, { message: PROCESS_DIAGNOSTICS.compatibility })
})

for (const stdout of [
  `API Error: 401 ${privateDetails}`,
  JSON.stringify({ type: 'user', message: { content: 'API Error: 401' } }),
  JSON.stringify({ type: 'assistant', error: 'authentication_error' }),
  JSON.stringify({ type: 'result', subtype: 'success', result: 'API Error: 401', errors: ['authentication_error'] }),
  JSON.stringify({ type: 'result', is_error: true, structured_output: { summary: 'API Error: 401' } }),
  JSON.stringify({ type: 'result', is_error: true, errors: 'API Error: 401' }),
  JSON.stringify({ type: 'result', is_error: true, errors: [{ message: 'API Error: 401' }] }),
  JSON.stringify({ type: 'result', is_error: true }),
  'null',
  '{"type":"result"',
  JSON.stringify({ type: 'result', is_error: true, errors: ['API Error: 401'] }) + '\n' +
    JSON.stringify({ type: 'result', subtype: 'success' })
]) {
  test(`should retain safe fallback when stdout is not a final known result error: ${stdout.slice(0, 60)}`, async () => {
    const child = fakeChild()
    const promise = runProcess('unused', [], { spawnProcess: () => child })
    child.stdout.emit('data', Buffer.from(stdout))
    child.stderr.emit('data', Buffer.from(`Unknown failure ${privateDetails}`))
    child.emit('close', 1)
    await assert.rejects(promise, { message: 'Agent process did not complete successfully.' })
  })
}

test('should prefer stderr diagnostics when final result reports a different category', async () => {
  const child = fakeChild()
  const promise = runProcess('unused', [], { spawnProcess: () => child })
  child.stderr.emit('data', Buffer.from('CERT_HAS_EXPIRED'))
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'result', is_error: true, errors: ['API Error: 401']
  })))
  child.emit('close', 1)
  await assert.rejects(promise, { message: PROCESS_DIAGNOSTICS.tls })
})

test('should preserve successful output when diagnostics contain known failure patterns', async () => {
  const child = fakeChild()
  const promise = runProcess('unused', [], { spawnProcess: () => child })
  const stdout = JSON.stringify({ type: 'result', is_error: true, errors: ['API Error: 401'] })
  child.stdout.emit('data', Buffer.from(stdout))
  child.stderr.emit('data', Buffer.from('CERT_HAS_EXPIRED'))
  child.emit('close', 0)
  assert.equal(await promise, stdout)
})

test('should retain the combined output budget over classified failures', async () => {
  const child = fakeChild()
  const promise = runProcess('unused', [], { maxBytes: 32, spawnProcess: () => child })
  child.stdout.emit('data', Buffer.from('x'.repeat(20)))
  child.stderr.emit('data', Buffer.from('CERT_HAS_EXPIRED'))
  child.emit('close', 1)
  await assert.rejects(promise, { message: 'Agent output budget exceeded.' })
})

test('should retain interruption precedence over classified failures', async () => {
  const controller = new AbortController()
  const child = fakeChild()
  const promise = runProcess('unused', [], { signal: controller.signal, spawnProcess: () => child })
  child.stderr.emit('data', Buffer.from('CERT_HAS_EXPIRED'))
  controller.abort()
  child.emit('close', 1)
  await assert.rejects(promise, { message: 'Agent execution was interrupted.' })
})

for (const groupFailure of [false, true]) {
  test(`should stop the isolated POSIX process tree when group termination ${groupFailure ? 'fails' : 'succeeds'}`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const child = fakeChild(123456)
    let childKilled = false
    child.kill = () => { childKilled = true }
    const kill = t.mock.method(process, 'kill', () => {
      if (groupFailure) throw Error('Process group already gone.')
      return true
    })
    try {
      const promise = runProcess('unused', [], { spawnProcess: (_command, _args, options) => {
        assert.equal(options.detached, true)
        return child
      } })
      child.emit('close', 0)
      assert.equal(await promise, '')
      assert.deepEqual(kill.mock.calls[0].arguments, [-123456, 'SIGKILL'])
      assert.equal(childKilled, groupFailure)
    } finally {
      kill.mock.restore()
      Object.defineProperty(process, 'platform', platform)
    }
  })
}

test('should avoid termination attempts when child has no process ID', async () => {
  const child = fakeChild(undefined)
  const promise = runProcess('unused', [], { spawnProcess: () => child })
  child.stdin.emit('error', Error('Closed pipe'))
  child.emit('close', 0)
  assert.equal(await promise, '')
})

test('should handle abort races when cancellation occurs during spawn', async () => {
  const controller = new AbortController()
  const child = fakeChild(undefined)
  const promise = runProcess('unused', [], { signal: controller.signal, spawnProcess: () => {
    controller.abort()
    return child
  } })
  child.emit('close', 0)
  await assert.rejects(promise, { message: 'Agent execution was interrupted.' })
})
