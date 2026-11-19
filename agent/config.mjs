import { readFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const BROWSER_TOOLS = ['browser_snapshot', 'browser_click', 'browser_wait_for']

export function resolveOutputDirectory(env) {
  return resolve(env.OUTPUT_DIR || '/OUTPUT_DIR')
}

export function parseAgentConfig(env) {
  try {
    if (!!env.AGENT_CONFIG_JSON_FILE === !!env.AGENT_CONFIG_JSON) throw new Error()
    const config = JSON.parse(env.AGENT_CONFIG_JSON_FILE
      ? readFileSync(env.AGENT_CONFIG_JSON_FILE, 'utf8')
      : env.AGENT_CONFIG_JSON)
    if (
      !record(config) ||
      Object.keys(config).some((key) => !['anthropicBaseUrl', 'model', 'authToken', 'apiKey', 'extraCaCertPem'].includes(key)) ||
      typeof config.model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(config.model) ||
      !!config.authToken === !!config.apiKey ||
      [config.authToken, config.apiKey].some(
        (value) => value !== undefined && (typeof value !== 'string' || !value || /[\r\n\0]/.test(value))
      ) ||
      (config.extraCaCertPem !== undefined &&
        (typeof config.extraCaCertPem !== 'string' ||
          !config.extraCaCertPem.includes('-----BEGIN CERTIFICATE-----') ||
          !config.extraCaCertPem.includes('-----END CERTIFICATE-----')))
    ) throw new Error()
    const url = new URL(config.anthropicBaseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error()
    return config
  } catch {
    throw new Error('Agent configuration is invalid.')
  }
}

async function containedFile(directory, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || win32.isAbsolute(path) || path.includes('\0')) {
    throw new Error()
  }
  const file = await realpath(resolve(directory, path))
  const child = relative(directory, file)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !(await stat(file)).isFile()) {
    throw new Error()
  }
  return file
}

export async function loadConsumerConfig(path) {
  try {
    if (typeof path !== 'string' || !path) throw new Error()
    const configPath = await realpath(resolve(path))
    const directory = dirname(configPath)
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const validList = (values, allowed) => Array.isArray(values) && values.length > 0 &&
      values.length <= 100 && values.every((value) =>
        typeof value === 'string' && /^[a-z][a-z0-9_-]{0,99}$/.test(value) && (!allowed || allowed.includes(value))) &&
      new Set(values).size === values.length
    if (!record(config) || config.schemaVersion !== 1 ||
        Object.keys(config).sort().join() !== 'prompt,requiredChecks,requiredTools,schemaVersion' ||
        !validList(config.requiredChecks) || !validList(config.requiredTools, BROWSER_TOOLS)) throw new Error()
    const promptPath = await containedFile(directory, config.prompt)
    const prompt = await readFile(promptPath, 'utf8')
    if (!prompt.trim()) throw new Error()
    return { ...config, prompt }
  } catch {
    throw new Error('Agent runtime arguments or consumer configuration are invalid.')
  }
}
