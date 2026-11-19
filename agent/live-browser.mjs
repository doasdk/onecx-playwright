import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveOutputDirectory } from './config.mjs'
import { browserEnvironment } from './security.mjs'

export async function createLiveBrowser({ chromium, contextOptions = {}, env = process.env }) {
  const root = resolveOutputDirectory(env)
  await mkdir(root, { recursive: true })
  const profile = await mkdtemp(join(root, '.agent-browser-'))
  let context
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await context?.close({ reason: 'Live browser fixture completed.' })
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
  try {
    await chmod(profile, 0o700)
    if ((contextOptions.args || []).some((arg) => /remote-debugging|user-data-dir/.test(arg))) throw new Error()
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...contextOptions,
      args: [
        ...(contextOptions.args || []),
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])
      ],
      env: browserEnvironment(env, profile)
    })
    let active
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        active = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
        break
      } catch {
        await delay(50)
      }
    }
    if (!active || !/^\d+$/.test(active[0]) || !/^\/devtools\/browser\/[\w-]+$/.test(active[1])) throw new Error()
    const cdpEndpoint = `ws://127.0.0.1:${active[0]}${active[1]}`
    const pages = context.pages()
    if (pages.length !== 1) throw new Error()
    return { page: pages[0], context, cdpEndpoint, close }
  } catch {
    try {
      await close()
    } catch {
      throw new Error('Live browser setup and cleanup failed; private diagnostics were suppressed.')
    }
    throw new Error('Live browser setup failed; private diagnostics were suppressed.')
  }
}

// Target ID identifies the tab; loader ID additionally detects reloads of that same tab.
export async function inspectLivePage(page, cdpEndpoint) {
  let session
  let identity
  let failed = false
  try {
    const endpoint = new URL(cdpEndpoint)
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !/^\/devtools\/browser\/[\w-]+$/.test(endpoint.pathname)) throw new Error()
    const target = new URL(page.url())
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || page.isClosed()) throw new Error()
    const context = page.context()
    if (context.pages().length !== 1 || context.pages()[0] !== page ||
        context.browser().contexts().length !== 1) throw new Error()
    session = await context.newCDPSession(page)
    const { targetInfo } = await session.send('Target.getTargetInfo')
    const { frameTree } = await session.send('Page.getFrameTree')
    const base = `http://127.0.0.1:${endpoint.port}`
    const request = async (path) => {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
      if (!response.ok) throw new Error()
      return response.json()
    }
    const version = await request('/json/version')
    const tabs = (await request('/json/list')).filter((item) => item.type === 'page')
    if (version.webSocketDebuggerUrl !== cdpEndpoint || tabs.length !== 1 || tabs[0].id !== targetInfo.targetId) throw new Error()
    identity = { targetId: targetInfo.targetId, loaderId: frameTree.frame.loaderId, url: page.url(), origin: target.origin }
  } catch {
    failed = true
  } finally {
    try {
      await session?.detach()
    } catch {
      failed = true
    }
  }
  if (failed) throw new Error('Live page identity validation failed.')
  return identity
}
