import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { assertSupportedIntegrationVersion } from './supported-version.mjs'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('@onecx/integration-tests'))
const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
assertSupportedIntegrationVersion(metadata.version)

const file = join(packageRoot, 'lib', 'containers', 'basic', 'onecx-ui.js')
const source = readFileSync(file, 'utf8')
const start = 'function buildUiTlsServerConf(upstreamPort) {'
const end = '\nclass UiContainer extends'
const startIndex = source.indexOf(start)
const endIndex = source.indexOf(end)
if (startIndex < 0 || endIndex <= startIndex || source.indexOf(start, startIndex + 1) !== -1) {
  throw new Error('Unexpected UI TLS implementation. Refusing to apply CORS patch.')
}
const original = `${start}
    return \`server {
  listen 8443 ssl;
  server_name _;
  ssl_certificate     /etc/nginx/certs/tls.crt;
  ssl_certificate_key /etc/nginx/certs/tls.key;
  location / {
    proxy_pass http://127.0.0.1:\${upstreamPort};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
\`;
}`
const replacement = `${start}
    return \`map $http_origin $onecx_tls_cors_origin {
  default "";
  "https://onecx-shell-ui:8443" $http_origin;
}
map $onecx_tls_cors_origin $onecx_tls_cors_headers {
  default "";
  "~.+" "Authorization, Origin, X-Requested-With, Content-Type, Accept, Accept-Language, apm-principal-token, $http_access_control_request_headers";
}
map $onecx_tls_cors_origin $onecx_tls_cors_credentials {
  default "";
  "https://onecx-shell-ui:8443" "true";
}
server {
  listen 8443 ssl;
  server_name _;
  ssl_certificate     /etc/nginx/certs/tls.crt;
  ssl_certificate_key /etc/nginx/certs/tls.key;
  location / {
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Credentials;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Methods;
    add_header Access-Control-Allow-Origin $onecx_tls_cors_origin always;
    add_header Access-Control-Allow-Credentials $onecx_tls_cors_credentials always;
    add_header Access-Control-Allow-Methods "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers $onecx_tls_cors_headers always;
    add_header Vary Origin always;
    if ($request_method = OPTIONS) {
      return 204;
    }
    proxy_pass http://127.0.0.1:\${upstreamPort};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
\`;
}`
const current = source.slice(startIndex, endIndex).trimEnd()
const previous = replacement
  .replace(/map \$onecx_tls_cors_origin \$onecx_tls_cors_headers \{[\s\S]*?\}\r?\n/, '')
  .replace('$onecx_tls_cors_headers', '"Authorization, Origin, X-Requested-With, Content-Type, Accept"')
if (current === original || current === previous) {
  writeFileSync(file, source.slice(0, startIndex) + replacement + '\n' + source.slice(endIndex))
} else if (current !== replacement) {
  throw new Error('Unexpected UI TLS configuration. Refusing to apply CORS patch.')
}
console.log(
  'UI CORS patch active: HTTPS listener permits the exact Shell origin and handles OPTIONS; upstream asset/API responses unchanged.'
)
