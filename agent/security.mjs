export function browserEnvironment(env, home) {
  const result = {}
  for (const key of [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'PLAYWRIGHT_BROWSERS_PATH'
  ]) {
    if (env[key]) result[key] = env[key]
  }
  return { ...result, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home }
}

export function redact(text, secrets = []) {
  let result = String(text)
  for (const secret of secrets
    .filter((value) => typeof value === 'string' && value)
    .sort((a, b) => b.length - a.length)) {
    for (const value of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      result = result.split(value).join('[REDACTED]')
    }
  }
  return result
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch {
        return '[REDACTED URL]'
      }
    })
    .replace(
      /((?:api[_-]?key|auth(?:orization|[_-]?token)?|password|secret|access_token|refresh_token)\s*["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
      '$1[REDACTED]'
    )
}
