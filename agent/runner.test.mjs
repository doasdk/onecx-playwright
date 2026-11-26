import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createLiveBrowser, inspectLivePage } from './live-browser.mjs'
import { runBrowserAgent } from './run.mjs'
import { BROWSER_TOOLS, loadConsumerConfig, parseAgentConfig, resolveOutputDirectory } from './config.mjs'
import { reportSchema, validateResult } from './report.mjs'
import { browserEnvironment, redact } from './security.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
const provider = { anthropicBaseUrl: 'https://model.example/api', model: 'test-model', authToken: 'model-secret' }
const consumer = { schemaVersion: 1, prompt: 'prompt.md', requiredChecks: ['content'], requiredTools: ['browser_snapshot'] }
const report = { schemaVersion: 1, verdict: 'passed', summary: 'Observed content.', checks: [{ name: 'content', verdict: 'passed', evidence: 'Visible content.' }] }
const events = (value = report) => [
  { type: 'system', subtype: 'init', mcp_servers: [{ name: 'browser', status: 'connected' }] },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'mcp__browser__browser_snapshot' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Observed content.' }] } },
  { type: 'result', subtype: 'success', structured_output: value }
]
const stream = (value = events()) => value.map((event) => JSON.stringify(event)).join('\n')
let browserRoot
let live
let server
let origin
before(async () => {
  browserRoot = await mkdtemp(join(directory, '.test-run-browser-'))
  server = createServer((_request, response) => response.end('<title>Ready</title><h1>Authenticated application</h1>')).listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
  live = await createLiveBrowser({ chromium, env: { ...process.env, OUTPUT_DIR: browserRoot } })
  await live.page.goto(origin)
})
after(async () => {
  await live?.close()
  if (server) await new Promise((resolve) => server.close(resolve))
  await rm(browserRoot, { recursive: true, force: true, maxRetries: 3 })
})
async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(directory, '.test-run-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const configPath = join(root, 'agent.config.json')
  await writeFile(configPath, JSON.stringify(consumer))
  await writeFile(join(root, 'prompt.md'), 'Observe the already authenticated page.')
  return {
    root, configPath,
    options: {
      page: live.page, cdpEndpoint: live.cdpEndpoint, configPath,
      env: { OUTPUT_DIR: join(root, 'output'), AGENT_CONFIG_JSON: JSON.stringify(provider), ...overrides },
      secrets: ['application-secret']
    },
    dependencies: { resolveBinary: (name) => name === '@playwright/mcp' ? 'mcp.js' : 'claude.exe', execute: async () => stream() },
    result: async () => JSON.parse(await readFile(join(root, 'output', 'agent-report.json'), 'utf8'))
  }
}
const run = (fixture) => runBrowserAgent(fixture.options, fixture.dependencies)

test('should pass and preserve the caller page when validated browser observations succeed', async (t) => {
  const fixture = await setup(t)
  const identity = await inspectLivePage(live.page, live.cdpEndpoint)
  assert.equal(await run(fixture), 0)
  assert.deepEqual(await fixture.result(), report)
  assert.deepEqual(await inspectLivePage(live.page, live.cdpEndpoint), identity)
  assert.deepEqual(await readdir(join(fixture.root, 'output')), ['agent-report.json'])
})

test('should expose only the existing page endpoint and selected tools when constructing isolated processes', async (t) => {
  const fixture = await setup(t, { APP_PASSWORD: 'application-secret', ANTHROPIC_API_KEY: 'untrusted', TLS_CA_CERT_PATH: 'app-ca' })
  fixture.dependencies.execute = async (_command, args, options) => {
    const mcp = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.browser
    assert.equal(mcp.args[mcp.args.indexOf('--cdp-endpoint') + 1], live.cdpEndpoint)
    assert.equal(mcp.args[mcp.args.indexOf('--allowed-origins') + 1], origin)
    for (const flag of ['--isolated', '--headless', '--executable-path', '--storage-state', '--ignore-https-errors', '--no-sandbox']) {
      assert.equal(mcp.args.includes(flag), false)
    }
    assert.equal(mcp.env.APP_PASSWORD, undefined)
    assert.equal(mcp.env.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.deepEqual(JSON.parse(mcp.env.ONECX_AGENT_TOOLS), ['browser_snapshot'])
    assert.equal(options.env.APP_PASSWORD, undefined)
    assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, 'model-secret')
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined)
    assert.equal(options.input.includes(origin), false)
    assert.match(args[args.indexOf('--system-prompt') + 1], /Never navigate, reload/)
    assert.equal(args.includes('mcp__browser__browser_navigate'), false)
    return stream()
  }
  assert.equal(await run(fixture), 0)
})

test('should redact application and model secrets when the model includes them in evidence', async (t) => {
  const fixture = await setup(t)
  fixture.dependencies.execute = async () => stream(events({
    ...report, summary: 'application-secret model-secret', checks: [{ ...report.checks[0], evidence: 'application-secret' }]
  }))
  assert.equal(await run(fixture), 0)
  assert.equal((await fixture.result()).summary, '[REDACTED] [REDACTED]')
  assert.equal((await fixture.result()).checks[0].evidence, '[REDACTED]')
})

for (const value of ['not-json', stream(events().slice(1)), stream(events().filter((event) => event.type !== 'user'))]) {
  test(`should fail closed when agent output lacks verified evidence (${value.slice(0, 20)})`, async (t) => {
    const fixture = await setup(t)
    fixture.dependencies.execute = async () => value
    assert.equal(await run(fixture), 1)
    assert.equal((await fixture.result()).verdict, 'inconclusive')
  })
}
for (const verdict of ['failed', 'inconclusive']) {
  test(`should return failure when a validated observation is ${verdict}`, async (t) => {
    const fixture = await setup(t)
    fixture.dependencies.execute = async () => stream(events({ ...report, verdict, checks: [{ ...report.checks[0], verdict }] }))
    assert.equal(await run(fixture), 1)
    assert.equal((await fixture.result()).verdict, verdict)
  })
}
for (const [key, value] of [['AGENT_TIMEOUT_MS', '0'], ['AGENT_MAX_TURNS', '51'], ['AGENT_CONFIG_JSON', '{}']]) {
  test(`should write a failure report when ${key} is invalid`, async (t) => {
    const fixture = await setup(t, { [key]: value })
    assert.equal(await run(fixture), 1)
    assert.equal((await fixture.result()).verdict, 'inconclusive')
  })
}
test('should stop before model execution when the caller page has extra tabs', async (t) => {
  const fixture = await setup(t)
  const extra = await live.context.newPage()
  try {
    fixture.dependencies.execute = async () => { assert.fail('must not execute') }
    assert.equal(await run(fixture), 1)
    assert.equal((await fixture.result()).summary, 'Live page identity validation failed.')
  } finally {
    await extra.close()
  }
})
test('should reject a reload of the same target when the model process completes', async (t) => {
  const fixture = await setup(t)
  fixture.dependencies.execute = async () => { await live.page.reload(); return stream() }
  assert.equal(await run(fixture), 1)
  assert.equal((await fixture.result()).summary, 'Live page identity validation failed.')
})
for (const endpoint of ['ws://0.0.0.0:123/devtools/browser/abc', 'wss://127.0.0.1:123/devtools/browser/abc', 'ws://user@127.0.0.1:123/devtools/browser/abc', 'ws://127.0.0.1:123/devtools/page/abc']) {
  test(`should reject unsafe CDP endpoint ${endpoint}`, async () => {
    await assert.rejects(inspectLivePage(live.page, endpoint), /identity validation failed/)
  })
}
test('should overwrite a stale pass when subprocess diagnostics are private', async (t) => {
  const fixture = await setup(t)
  await mkdir(join(fixture.root, 'output'))
  await writeFile(join(fixture.root, 'output', 'agent-report.json'), JSON.stringify(report))
  fixture.dependencies.execute = async () => { throw new Error('application-secret private URL') }
  assert.equal(await run(fixture), 1)
  assert.equal((await fixture.result()).summary.includes('private URL'), false)
  assert.deepEqual(await readdir(join(fixture.root, 'output')), ['agent-report.json'])
})
test('should fail closed when private process state cannot be cleaned', async (t) => {
  const fixture = await setup(t)
  fixture.dependencies.removePrivateState = async () => { throw new Error('private detail') }
  assert.equal(await run(fixture), 1)
  assert.equal((await fixture.result()).summary, 'Private agent state could not be removed.')
})
test('should interrupt model execution when its time budget expires', async (t) => {
  const fixture = await setup(t, { AGENT_TIMEOUT_MS: '100' })
  fixture.dependencies.execute = async (_command, _args, { signal }) => {
    if (!signal.aborted) await once(signal, 'abort')
    signal.throwIfAborted()
  }
  assert.equal(await run(fixture), 1)
  assert.match((await fixture.result()).summary, /interrupted or exceeded/)
})
test('should load the committed example when supplied as consumer config', async () => {
  const config = await loadConsumerConfig(join(directory, '..', 'examples', 'browser-agent', 'agent.config.json'))
  assert.deepEqual(config.requiredTools, ['browser_snapshot'])
  assert.equal(config.authentication, undefined)
})
for (const change of [
  { authentication: 'authenticate.mjs' }, { requiredTools: ['browser_navigate'] },
  { requiredTools: [] }, { requiredChecks: ['duplicate', 'duplicate'] },
  { prompt: '../outside.md' }, { prompt: 'C:\\private.md' }, { schemaVersion: 2 }
]) {
  test(`should reject consumer configuration when ${JSON.stringify(change)} is supplied`, async (t) => {
    const fixture = await setup(t)
    await writeFile(fixture.configPath, JSON.stringify({ ...consumer, ...change }))
    await assert.rejects(loadConsumerConfig(fixture.configPath), /consumer configuration are invalid/)
  })
}
test('should reject an escaping prompt symlink when the target is outside the config directory', async (t) => {
  const fixture = await setup(t)
  await mkdir(join(fixture.root, 'nested'))
  const nested = join(fixture.root, 'nested', 'agent.config.json')
  await writeFile(nested, JSON.stringify(consumer))
  try {
    await symlink(join(fixture.root, 'prompt.md'), join(fixture.root, 'nested', 'prompt.md'))
  } catch (error) {
    if (error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return }
    throw error
  }
  await assert.rejects(loadConsumerConfig(nested), /consumer configuration are invalid/)
})
test('should preserve restricted environment and remove all encoded secret variants when redacting', () => {
  const minimal = browserEnvironment({ PATH: 'bin', APP_PASSWORD: 'secret' }, 'private-home')
  assert.equal(minimal.APP_PASSWORD, undefined)
  assert.equal(minimal.HOME, 'private-home')
  assert.equal(redact('a%2Fb a/b', ['a/b']), '[REDACTED] [REDACTED]')
  assert.equal(BROWSER_TOOLS.includes('browser_navigate'), false)
  assert.ok(resolveOutputDirectory({}).endsWith('OUTPUT_DIR'))
})
test('should require complete exact check schema when producing report constraints', () => {
  assert.equal(reportSchema(['content']).properties.checks.minItems, 1)
  assert.throws(() => validateResult(stream(events({ ...report, verdict: 'failed' })), ['content'], ['browser_snapshot']), /inconsistent/)
})
for (const invalid of [{}, { ...provider, apiKey: 'both' }, { ...provider, anthropicBaseUrl: 'http://model.example' }, { ...provider, model: 'bad model' }]) {
  test(`should reject invalid provider configuration ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => parseAgentConfig({ AGENT_CONFIG_JSON: JSON.stringify(invalid) }), /configuration is invalid/)
  })
}
test('should resolve the CJS bridge without launching a browser when imported', async () => {
  const bridge = await import('./playwright.cjs')
  assert.equal(typeof bridge.createLiveBrowser, 'function')
  assert.equal(typeof bridge.runBrowserAgent, 'function')
  await assert.rejects(access(join(directory, 'authentication.mjs')))
})

test('should forward both public CJS functions when runtime methods are called', async (t) => {
  const bridge = await import('./playwright.cjs')
  const fixture = await setup(t)
  await assert.rejects(bridge.createLiveBrowser({
    chromium: { launchPersistentContext: async () => { throw new Error() } },
    env: fixture.options.env
  }), /Live browser setup failed/)
  assert.equal(await bridge.runBrowserAgent({ ...fixture.options, configPath: '' }), 1)
})

test('should replace a stale passing report before browser authentication is prepared', async (t) => {
  const fixture = await setup(t)
  const bridge = await import('./playwright.cjs')
  await mkdir(join(fixture.root, 'output'))
  await writeFile(join(fixture.root, 'output', 'agent-report.json'), JSON.stringify(report))
  assert.equal(await bridge.initializeAgentReport({ configPath: fixture.configPath, env: fixture.options.env }), undefined)
  assert.deepEqual(await fixture.result(), {
    schemaVersion: 1,
    verdict: 'inconclusive',
    summary: 'Authenticated browser preparation did not complete.',
    checks: [{ name: 'content', verdict: 'inconclusive', evidence: 'Not verified by a completed agent run.' }]
  })
})

test('should retain a failure report when consumer configuration cannot be loaded before login', async (t) => {
  const fixture = await setup(t)
  const bridge = await import('./playwright.cjs')
  await assert.rejects(bridge.initializeAgentReport({ configPath: '', env: fixture.options.env }), /consumer configuration are invalid/)
  assert.equal((await fixture.result()).verdict, 'inconclusive')
  assert.deepEqual((await fixture.result()).checks, [])
})

test('should use the process environment when initializing authentication reporting without an explicit environment', async (t) => {
  const fixture = await setup(t)
  const bridge = await import('./playwright.cjs')
  const previous = process.env.OUTPUT_DIR
  process.env.OUTPUT_DIR = fixture.options.env.OUTPUT_DIR
  try {
    await bridge.initializeAgentReport({ configPath: fixture.configPath })
    assert.equal((await fixture.result()).verdict, 'inconclusive')
  } finally {
    if (previous === undefined) delete process.env.OUTPUT_DIR
    else process.env.OUTPUT_DIR = previous
  }
})

test('should use the installed native binaries without making model requests when execution is injected', async (t) => {
  const fixture = await setup(t)
  delete fixture.dependencies.resolveBinary
  fixture.dependencies.execute = async (command) => {
    assert.match(command, /claude(?:\.exe)?$/)
    return stream()
  }
  assert.equal(await run(fixture), 0)
})
test('should use API key and private CA trust when the provider requires them', async (t) => {
  const ca = '-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----'
  const fixture = await setup(t, {
    AGENT_CONFIG_JSON: JSON.stringify({ anthropicBaseUrl: provider.anthropicBaseUrl, model: provider.model, apiKey: 'key-secret', extraCaCertPem: ca }),
    AGENT_MAX_TURNS: '2'
  })
  fixture.dependencies.execute = async (_command, args, { env }) => {
    assert.equal(env.ANTHROPIC_API_KEY, 'key-secret')
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(await readFile(env.NODE_EXTRA_CA_CERTS, 'utf8'), ca)
    assert.equal(args[args.indexOf('--max-turns') + 1], '2')
    return stream()
  }
  assert.equal(await run(fixture), 0)
})
test('should load private provider configuration when a file is supplied', async (t) => {
  const fixture = await setup(t)
  const path = join(fixture.root, 'model.json')
  await writeFile(path, JSON.stringify(provider))
  assert.deepEqual(parseAgentConfig({ AGENT_CONFIG_JSON_FILE: path }), provider)
})
test('should reject ambiguous provider sources when file and inline configurations are supplied', () => {
  assert.throws(() => parseAgentConfig({ AGENT_CONFIG_JSON_FILE: 'file', AGENT_CONFIG_JSON: '{}' }), /configuration is invalid/)
})
for (const extraCaCertPem of ['', 'not a certificate', 1]) {
  test(`should reject invalid CA trust when ${JSON.stringify(extraCaCertPem)} is supplied`, () => {
    assert.throws(() => parseAgentConfig({ AGENT_CONFIG_JSON: JSON.stringify({ ...provider, extraCaCertPem }) }), /configuration is invalid/)
  })
}
test('should stop without executing a model when the caller signal is already aborted', async (t) => {
  const fixture = await setup(t)
  const controller = new AbortController()
  controller.abort()
  fixture.options.signal = controller.signal
  fixture.dependencies.execute = async () => assert.fail('must not execute')
  assert.equal(await run(fixture), 1)
  assert.match((await fixture.result()).summary, /interrupted/)
})
test('should interrupt the model when the caller aborts during execution', async (t) => {
  const fixture = await setup(t)
  const controller = new AbortController()
  fixture.options.signal = controller.signal
  fixture.dependencies.execute = async (_command, _args, { signal }) => {
    controller.abort()
    signal.throwIfAborted()
  }
  assert.equal(await run(fixture), 1)
  assert.match((await fixture.result()).summary, /interrupted/)
})
test('should interrupt safely when a process termination signal is received during execution', async (t) => {
  const fixture = await setup(t)
  fixture.dependencies.execute = async (_command, _args, { signal }) => {
    process.listeners('SIGTERM').at(-1)()
    signal.throwIfAborted()
  }
  assert.equal(await run(fixture), 1)
  assert.match((await fixture.result()).summary, /interrupted/)
})
for (const secrets of ['secret', [42]]) {
  test(`should reject invalid redaction values when ${JSON.stringify(secrets)} is supplied`, async (t) => {
    const fixture = await setup(t)
    fixture.options.secrets = secrets
    assert.equal(await run(fixture), 1)
  })
}
test('should refuse legacy JS Claude launchers when a native executable is required', async (t) => {
  const fixture = await setup(t)
  fixture.dependencies.resolveBinary = () => 'cli.js'
  assert.equal(await run(fixture), 1)
})
test('should return safe startup diagnostics when the default process runner cannot start', async (t) => {
  const fixture = await setup(t)
  fixture.dependencies.resolveBinary = (name) => name === '@playwright/mcp' ? 'mcp.js' : 'no-such-executable-123456'
  delete fixture.dependencies.execute
  assert.equal(await run(fixture), 1)
  assert.equal((await fixture.result()).summary, 'Cannot start the installed agent process.')
})
for (const prompt of ['', '   ']) {
  test(`should reject an empty consumer prompt when ${JSON.stringify(prompt)} is supplied`, async (t) => {
    const fixture = await setup(t)
    await writeFile(join(fixture.root, 'prompt.md'), prompt)
    await assert.rejects(loadConsumerConfig(fixture.configPath), /consumer configuration are invalid/)
  })
}
test('should suppress unsafe URL components and common credential fields when redacting report text', () => {
  assert.equal(redact('https://user:pass@app.example/path?token=private#private'), 'https://app.example/path')
  assert.equal(redact('password=private'), 'password=[REDACTED]')
  assert.equal(redact('https://['), '[REDACTED URL]')
})

for (const change of [
  (items) => { items.at(-1).structured_output.extra = true },
  (items) => { items.at(-1).structured_output.schemaVersion = 2 },
  (items) => { items.at(-1).structured_output.summary = '' },
  (items) => { items.at(-1).structured_output.checks = [] },
  (items) => { items.at(-1).structured_output.checks[0].name = 'unexpected' },
  (items) => { items.at(-1).structured_output.checks[0].evidence = '' },
  (items) => { items.at(-1).is_error = true },
  (items) => { items.at(-1).subtype = 'error' },
  (items) => { items[2].message.content[0].is_error = true },
  (items) => { items[2].tool_use_result = { isError: true } },
  (items) => { items[2].message.content[0].content = '### Error\nCannot observe' },
  (items) => { items[2].message.content[0].content = '' },
  (items) => { items[2].message.content[0].tool_use_id = 'unknown' },
  (items) => { delete items[1].message },
  (items) => { delete items[2].message }
]) {
  test(`should reject invalid report or tool evidence when ${change.toString()} is applied`, () => {
    const items = JSON.parse(JSON.stringify(events()))
    change(items)
    assert.throws(() => validateResult(stream(items), ['content'], ['browser_snapshot']))
  })
}
test('should accept structured tool content when the tool succeeds without a plain-text result', () => {
  const items = JSON.parse(JSON.stringify(events()))
  items[2].message.content[0].content = [{ type: 'text', text: 'Observed content.' }]
  assert.deepEqual(validateResult(stream(items), ['content'], ['browser_snapshot']), report)
})
for (const options of [
  { url: 'about:blank', closed: false }, { url: 'https://app.example', closed: true },
  { url: 'https://user:pass@app.example', closed: false }
]) {
  test(`should reject an unready or unsafe caller page when ${JSON.stringify(options)} is supplied`, async () => {
    await assert.rejects(inspectLivePage({ url: () => options.url, isClosed: () => options.closed }, live.cdpEndpoint), /identity validation failed/)
  })
}
for (const result of [
  { ok: false },
  { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/wrong' }) }
]) {
  test(`should reject an unverified endpoint when CDP discovery returns ${JSON.stringify(result)}`, async (t) => {
    const fetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (String(url).endsWith('/json/list')) return fetch(url, options)
      return result
    })
    await assert.rejects(inspectLivePage(live.page, live.cdpEndpoint), /identity validation failed/)
  })
}
test('should suppress private CDP detach failures when identity inspection cannot cleanly disconnect', async () => {
  const session = {
    send: async () => { throw new Error('private CDP diagnostic') },
    detach: async () => { throw new Error('private cleanup diagnostic') }
  }
  const context = {
    pages: () => [page],
    browser: () => ({ contexts: () => [context] }),
    newCDPSession: async () => session
  }
  const page = { url: () => origin, isClosed: () => false, context: () => context }
  await assert.rejects(inspectLivePage(page, live.cdpEndpoint), { message: 'Live page identity validation failed.' })
})
