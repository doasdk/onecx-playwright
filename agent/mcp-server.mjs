import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { browserEnvironment } from './security.mjs'
import { BROWSER_TOOLS } from './config.mjs'

// Claude's MCP environment inherits its model credentials; the browser server must not.
const allowed = JSON.parse(process.env.ONECX_AGENT_TOOLS || '[]')
if (!Array.isArray(allowed) || !allowed.length || allowed.some((name) => !BROWSER_TOOLS.includes(name))) process.exit(1)
const child = spawn(process.execPath, process.argv.slice(2), {
  env: browserEnvironment(process.env, process.env.HOME),
  stdio: ['pipe', 'pipe', 'ignore'],
  windowsHide: true
})
const listings = new Set()
const send = (stream, message) => stream.write(`${JSON.stringify(message)}\n`)
createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const message = JSON.parse(line)
    if (message.method === 'tools/list') listings.add(message.id)
    if (message.method === 'tools/call' && !allowed.includes(message.params?.name)) {
      send(process.stdout, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Tool is not permitted in live-page mode.' } })
    } else send(child.stdin, message)
  } catch {
    process.exitCode = 1
    child.kill()
  }
}).on('close', () => child.stdin.end())
createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const message = JSON.parse(line)
    if (listings.delete(message.id) && message.result?.tools) {
      message.result.tools = message.result.tools.filter((tool) => allowed.includes(tool.name))
    }
    send(process.stdout, message)
  } catch {
    process.exitCode = 1
    child.kill()
  }
})
child.stdin.on('error', () => {})
child.on('error', () => process.exit(1))
child.on('exit', (code) => process.exit(code === 0 ? 0 : 1))
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => child.kill(name))
