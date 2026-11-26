import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { browserEnvironment } from './security.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
async function execute(t, { script, input = '', allowed = '["browser_snapshot"]', args, before = '', after = '' } = {}) {
  const home = await mkdtemp(join(directory, '.test-shim-'))
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }))
  const shim = join(directory, 'mcp-server.mjs')
  const arguments_ = args || ['-e', script]
  const invocation = before || after ? [
    '-e', `process.argv=${JSON.stringify([process.execPath, shim, ...arguments_])};${before};
      import(${JSON.stringify(pathToFileURL(shim).href)}).then(()=>{${after}})`
  ] : [shim, ...arguments_]
  const child = spawn(process.execPath, invocation, {
    env: {
      ...browserEnvironment(process.env, home),
      ...(allowed === null ? {} : { ONECX_AGENT_TOOLS: allowed }),
      APP_PASSWORD: 'app-secret', ANTHROPIC_API_KEY: 'model-secret', CI: 'true'
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  t.after(() => child.kill())
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data) => { stdout += data })
  child.stderr.on('data', (data) => { stderr += data })
  child.stdin.on('error', () => {})
  const done = once(child, 'close')
  child.stdin.end(input)
  const [code] = await done
  return { code, stdout, stderr }
}
test('should remove model and application credentials when starting the MCP child', { timeout: 10_000 }, async (t) => {
  const result = await execute(t, {
    script: `process.stdin.resume(); console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{model:process.env.ANTHROPIC_API_KEY??null,app:process.env.APP_PASSWORD??null,tools:process.env.ONECX_AGENT_TOOLS??null,ci:process.env.CI??null}}))`
  })
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout).result, { model: null, app: null, tools: null, ci: null })
})
test('should place MCP sockets in the private home when starting a child', { timeout: 10_000 }, async (t) => {
  const result = await execute(t, {
    script: `process.stdin.resume(); console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{cwd:process.cwd(),home:process.env.HOME,sockets:process.env.PWTEST_SOCKETS_DIR??null}}))`
  })
  const child = JSON.parse(result.stdout).result
  assert.equal(child.cwd.toLowerCase(), child.home.toLowerCase())
  assert.equal(child.sockets, process.platform === 'win32' ? null : 's')
})
for (const allowed of [null, '[]', '["browser_navigate"]', '"browser_snapshot"']) {
  test(`should refuse MCP startup when the allowed tools value is ${allowed}`, { timeout: 10_000 }, async (t) => {
    assert.equal((await execute(t, { script: 'process.stdin.resume()', allowed })).code, 1)
  })
}
test('should reject malformed incoming JSON without forwarding private input', { timeout: 10_000 }, async (t) => {
  const result = await execute(t, { script: 'process.stdin.resume()', input: 'private invalid JSON\n' })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
test('should suppress malformed child output when MCP violates the protocol', { timeout: 10_000 }, async (t) => {
  const result = await execute(t, { script: 'console.log("private invalid JSON");setInterval(()=>{},1000)' })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
test('should preserve nonzero startup status without exposing child diagnostics', { timeout: 10_000 }, async (t) => {
  const result = await execute(t, { script: 'process.stderr.write("private");process.exit(2)' })
  assert.equal(result.code, 1)
  assert.equal(result.stderr, '')
})
test('should suppress private spawn errors when the MCP executable cannot start', { timeout: 10_000 }, async (t) => {
  const result = await execute(t, {
    script: 'process.stdin.resume()',
    before: 'Object.defineProperty(process,"execPath",{value:"no-such-executable-123456"})'
  })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
for (const name of ['SIGINT', 'SIGTERM']) {
  test(`should forward ${name} to the owned MCP child when shutdown is requested`, { timeout: 10_000 }, async (t) => {
    const result = await execute(t, {
      script: 'process.stdin.resume()',
      after: `process.emit(${JSON.stringify(name)})`
    })
    assert.equal(result.code, 1)
    assert.equal(result.stderr, '')
  })
}
test('should ignore broken MCP stdin after the child has disconnected', { timeout: 10_000 }, async (t) => {
  const result = await execute(t, {
    script: '',
    before: `
      const { EventEmitter } = require('node:events');
      const { PassThrough } = require('node:stream');
      globalThis.testChild = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), kill() {}
      });
      require('node:child_process').spawn = () => globalThis.testChild;
      require('node:module').syncBuiltinESMExports()
    `,
    after: `
      globalThis.testChild.stdin.emit('error', new Error('private broken pipe'));
      globalThis.testChild.emit('exit', 0)
    `
  })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
