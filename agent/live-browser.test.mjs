import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { createLiveBrowser, inspectLivePage } from './live-browser.mjs'
import { browserEnvironment } from './security.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
let root
let server
let origin
before(async () => {
  root = await mkdtemp(join(directory, '.test-live-'))
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<title>Live application</title><h1>Authenticated application</h1>
      <button onclick="document.querySelector('output').textContent =
        sessionStorage.getItem('authenticated') + ':' + window.sdkToken">Inspect session</button><output></output>`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

test('should preserve authenticated memory and the exact tab when real pinned MCP attaches and disconnects', { timeout: 60_000 }, async () => {
  const live = await createLiveBrowser({
    chromium,
    contextOptions: {
      ignoreHTTPSErrors: true,
      ...(process.env.ONECX_AGENT_TEST_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.ONECX_AGENT_TEST_CHROMIUM_EXECUTABLE }
        : {})
    },
    env: { ...process.env, OUTPUT_DIR: root }
  })
  const home = join(root, '.mcp-home')
  await mkdir(home)
  let child
  try {
    assert.equal(live.page.url(), 'about:blank')
    await live.page.goto(origin)
    await live.page.evaluate(() => {
      sessionStorage.setItem('authenticated', 'authenticated')
      window.sdkToken = 'in-memory-sdk-state'
      document.querySelector('h1').textContent = 'Ready without a reload'
    })
    const identity = await inspectLivePage(live.page, live.cdpEndpoint)
    const shim = join(directory, 'mcp-server.mjs')
    const mcp = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js')
    child = spawn(process.execPath, [
      shim, mcp, '--cdp-endpoint', live.cdpEndpoint, '--allowed-origins', origin,
      '--no-webmcp', '--codegen', 'none', '--output-dir', home
    ], {
      env: {
        ...browserEnvironment(process.env, home),
        ONECX_AGENT_TOOLS: JSON.stringify(['browser_snapshot', 'browser_click', 'browser_wait_for']),
        ANTHROPIC_AUTH_TOKEN: 'must-not-reach-browser'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let id = 0
    const pending = new Map()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      pending.get(message.id)?.(message)
    })
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const current = ++id
      const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 20_000)
      pending.set(current, (message) => {
        clearTimeout(timer)
        pending.delete(current)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`)
    })
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-test', version: '1' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const tools = await request('tools/list')
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['browser_click', 'browser_snapshot', 'browser_wait_for'])
    await assert.rejects(request('tools/call', { name: 'browser_navigate', arguments: { url: origin } }), /not permitted/)
    const snapshot = await request('tools/call', { name: 'browser_snapshot', arguments: {} })
    assert.notEqual(snapshot.isError, true)
    const text = snapshot.content.map((item) => item.text || '').join('\n')
    assert.match(text, /Ready without a reload/)
    const ref = text.match(/button "Inspect session" \[ref=([^\]]+)\]/)?.[1]
    assert.ok(ref, 'snapshot exposes existing button reference')
    const clicked = await request('tools/call', { name: 'browser_click', arguments: { target: ref } })
    assert.notEqual(clicked.isError, true, JSON.stringify(clicked))
    assert.equal(await live.page.locator('output').textContent(), 'authenticated:in-memory-sdk-state')
    assert.deepEqual(await inspectLivePage(live.page, live.cdpEndpoint), identity)
    const exited = once(child, 'exit')
    child.stdin.end()
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('MCP disconnect timed out')), 10_000).unref())])
    assert.deepEqual(await inspectLivePage(live.page, live.cdpEndpoint), identity)
    assert.equal(await live.page.evaluate(() => window.sdkToken), 'in-memory-sdk-state')
  } finally {
    child?.kill()
    await live.close()
    await live.close()
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
  }
  assert.deepEqual(await readdir(root), [])
})

test('should remove the private profile when browser launch fails', async () => {
  await assert.rejects(createLiveBrowser({
    chromium: { launchPersistentContext: async () => { throw new Error('private credential') } },
    env: { OUTPUT_DIR: root }
  }), /Live browser setup failed/)
  assert.deepEqual(await readdir(root), [])
})

test('should reject debugging overrides without starting a browser when caller options are unsafe', async () => {
  await assert.rejects(createLiveBrowser({
    chromium, contextOptions: { args: ['--remote-debugging-address=0.0.0.0'] }, env: { OUTPUT_DIR: root }
  }), /Live browser setup failed/)
  assert.deepEqual(await readdir(root), [])
})

test('should wait for DevToolsActivePort and preserve context options when Chromium reports its endpoint asynchronously', async () => {
  const page = {}
  let observed
  const chromium = {
    launchPersistentContext: async (profile, options) => {
      observed = options
      setTimeout(() => writeFile(join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/test-id\n'), 80)
      return { pages: () => [page], close: async () => {} }
    }
  }
  const live = await createLiveBrowser({ chromium, contextOptions: { ignoreHTTPSErrors: true }, env: { OUTPUT_DIR: root, APP_PASSWORD: 'secret' } })
  try {
    assert.equal(live.page, page)
    assert.equal(live.cdpEndpoint, 'ws://127.0.0.1:12345/devtools/browser/test-id')
    assert.equal(observed.ignoreHTTPSErrors, true)
    assert.equal(observed.env.APP_PASSWORD, undefined)
  } finally {
    await live.close()
  }
  assert.deepEqual(await readdir(root), [])
})
test('should disable the sandbox only when the trusted runtime is root', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'getuid')
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 0 })
  try {
    const live = await createLiveBrowser({
      chromium: {
        launchPersistentContext: async (profile, options) => {
          assert.ok(options.args.includes('--no-sandbox'))
          await writeFile(join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/test-id')
          return { pages: () => [{}], close: async () => {} }
        }
      },
      contextOptions: { args: ['--disable-background-networking'] },
      env: { OUTPUT_DIR: root }
    })
    await live.close()
  } finally {
    if (original) Object.defineProperty(process, 'getuid', original)
    else delete process.getuid
  }
})
for (const [contents, pages] of [['invalid\n/devtools/browser/id', [{}]], ['1234\n/devtools/page/id', [{}]], ['1234\n/devtools/browser/id', []]]) {
  test(`should clean up when Chromium returns invalid endpoint or pages (${contents}, ${pages.length})`, async () => {
    await assert.rejects(createLiveBrowser({
      chromium: {
        launchPersistentContext: async (profile) => {
          await writeFile(join(profile, 'DevToolsActivePort'), contents)
          return { pages: () => pages, close: async () => {} }
        }
      },
      env: { OUTPUT_DIR: root }
    }), /Live browser setup failed/)
    assert.deepEqual(await readdir(root), [])
  })
}
test('should suppress cleanup diagnostics and still delete the profile when failed setup cannot close the browser', async () => {
  await assert.rejects(createLiveBrowser({
    chromium: {
      launchPersistentContext: async (profile) => {
        await writeFile(join(profile, 'DevToolsActivePort'), 'invalid')
        return { close: async () => { throw new Error('private credential') } }
      }
    },
    env: { OUTPUT_DIR: root }
  }), /Live browser setup and cleanup failed; private diagnostics were suppressed/)
  assert.deepEqual(await readdir(root), [])
})
