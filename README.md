# OneCX Playwright runtime

A thin shared base image for OneCX app-specific E2E images. Version 0.0.2
provides Playwright 1.64.0 browsers and OS dependencies on Ubuntu Noble,
Node 22.22.0, npm, and an inherited test launcher. The initial supported image
platform is Linux amd64.

## Responsibility boundaries

| Layer | Owns |
| --- | --- |
| This image | Browser/OS runtime, Node/npm, launcher, runner-version validation |
| `onecx-common-e2e` package | Login, authenticated fixtures, shell page objects, accessibility helpers |
| App repository | Locked npm dependencies, app tests/page objects, routes, runtime user selection |
| Platform orchestrator | Services, data import, version matrix, runtime URLs/secrets/CA, reporting |

This image deliberately does not install Playwright's npm runner or the common
package. The consumer installs both using its automation lockfile. Installing
them into the same directory here would be undone by the consumer's `npm ci`;
installing them elsewhere would introduce a hidden module-resolution contract.
Browsers are already installed by the upstream image and are not downloaded
again during app dependency installation.

Authentication is performed at runtime by the shared Playwright fixtures.
There are no stored sessions, credentials, app tests, Docker socket, Java, or
platform services in this image. A derived app image runs as one E2E container.
An orchestrator may separately provision the OneCX service containers.

## Consume the image

After publication, pin a release tag, preferably its digest:

```dockerfile
FROM ghcr.io/doasdk/onecx-playwright:0.1.0

COPY integration/package.json integration/package-lock.json ./
# Required only while the app consumes a vendored common-package archive.
COPY integration/vendor/ ./vendor/
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund

COPY integration/e2e/ ./e2e/
COPY integration/playwright.config.ts integration/tsconfig.json ./
```

Do not copy the app's old `docker-entrypoint.sh` or redeclare its ENTRYPOINT:
inherit this image's launcher. Keep `@playwright/test` pinned to 1.64.0 in the
consumer. Ensure its common package satisfies that runner's peer dependency.
The default command is the consumer's `tests:gui` npm script. Angular/Karma
dependencies stay in the application package, not this runtime.

```shell
docker run --rm --init \
  -e ENV=container \
  -e ENVIRONMENTS_JSON_FILE=/run/secrets/environments.json \
  -e TEST_DATA_JSON_FILE=/run/secrets/data.json \
  --mount type=bind,src=/absolute/environments.json,dst=/run/secrets/environments.json,readonly \
  --mount type=bind,src=/absolute/data.json,dst=/run/secrets/data.json,readonly \
  --mount type=bind,src=/absolute/results,dst=/e2e-results \
  <app-e2e-image> tests:all --project=chromium
```

The app must be able to reach the configured platform URLs. Supply platform
metadata and CA through the orchestrator when running a version matrix.
Never put runtime configuration or credentials into Docker build arguments,
layers, or test archives.

## Launcher contract

Image label `org.onecx.playwright.contract="1"` identifies the dedicated runtime
contract. Both standalone Docker runs and orchestrators inherit ENTRYPOINT;
neither injects Node launcher code. Supply `ONECX_RUNTIME_FILE` as the path of a
readable, preferably read-only mounted JSON file:

```json
{
  "version": 1,
  "script": "tests:gui",
  "config": "playwright.config.ts",
  "environment": {
    "CI": "true",
    "ENV": "container",
    "ENVIRONMENTS_JSON": "{}",
    "TEST_DATA_JSON": "{}",
    "BASE_URL": "https://platform.example",
    "PLATFORM_INFO_JSON": "{}",
    "CAPTURE_PRIVATE_ARTIFACTS": "false",
    "TLS_CA_CERT_PATH": "/run/secrets/platform-ca.pem",
    "OUTPUT_DIR": "/e2e-results"
  }
}
```

All four top-level fields are required; additional fields and versions other
than numeric `1` are rejected. Script and config must be nonempty strings.
Environment must be an object with string values (no NUL characters). Values
are passed verbatim, never interpreted as shell code or parsed as application
JSON. There are no app-specific keys, routes, or authentication logic here.
The common app-owned npm package still owns authentication.

Generic application environment names are accepted, not just the example
settings. Names must match `[A-Za-z_][A-Za-z0-9_]*`. The envelope cannot override
launcher/runtime/process settings: case-insensitive `NODE_*`, `NPM_*`,
`ONECX_*`, `PLAYWRIGHT_*`, `LD_*`, `DYLD_*`, and `TEST_*` (except
`TEST_DATA_JSON`) are reserved. `PATH`, `PATHEXT`, `HOME`, `USERPROFILE`, `SHELL`,
`COMSPEC`, `BASH_ENV`, `ENVIRONMENT`, `BASHOPTS`, `SHELLOPTS`, `IFS`, `PWD`,
`OLDPWD`, `INIT_CWD`, `TMP`, `TEMP`, `TMPDIR`, `GCONV_PATH`, `LOCPATH`,
`OPENSSL_CONF`, `OPENSSL_MODULES`, `SSLKEYLOGFILE`, `CDPATH`, `ZDOTDIR`, and prototype-related names
are also rejected. `ENV` is an intentionally supported application setting.
`OUTPUT_DIR` and `TLS_CA_CERT_PATH` are supported controlled settings.
Image-level environment remains trusted configuration; do not expose arbitrary
Docker environment overrides to untrusted inputs.

The envelope script/config override standalone script/config settings.
Config may be absolute or relative to `TEST_ROOT`, but its resolved real path
must be a readable regular file inside the real test root, including symlink
resolution. Without an envelope, `ONECX_PLAYWRIGHT_CONFIG` selects the config;
otherwise detection prefers `playwright.config.ts`, then `playwright.config.js`.
The launcher passes the validated path using `--config` to the npm script, which
must support Playwright CLI arguments. Forwarded `--config`/`-c` overrides are
rejected; select config through the contract instead.

- `TEST_ROOT` defaults to `/app/integration`, containing the app's package.json.
- `TEST_SCRIPT` overrides the first command argument; otherwise that argument
  selects the script, defaulting to `tests:gui`.
- Arguments after the script are passed to npm/Playwright unchanged.
- `OUTPUT_DIR` defaults to `/e2e-results`; the app's reporters must use it.
- `TLS_CA_CERT_PATH`, if supplied, must be a readable regular file (relative
  paths resolve against `TEST_ROOT`) and sets `NODE_EXTRA_CA_CERTS` in the npm
  child environment before npm's Node process starts.
  Browser TLS behavior remains the app/configuration's responsibility.
- A first argument of `sh` executes directly, supporting platform image probes.
  Other non-test commands should explicitly override the entrypoint.
- Missing manifests/scripts/dependencies or mismatched Playwright versions fail.
  The launcher never installs dependencies or authenticates silently.

The launcher spawns `npm run` with inherited stdio and forwards SIGINT, SIGTERM,
and SIGHUP to its process group. Use Docker's `--init` for browser child-process
reaping. It writes **`OUTPUT_DIR/execution.json`**, with exactly:

```json
{"version":1,"status":"success","exitCode":0}
```

| Status | Container/manifest exit code |
| --- | --- |
| `success` | 0 |
| `test-failed` | npm's nonzero exit code; 127 when npm cannot start |
| `configuration-failed` | 2 |
| `interrupted` | 128 + signal number (SIGINT 130, SIGTERM 143, SIGHUP 129) |

The output directory is created and checked for writability before app
validation, including the envelope-selected directory as soon as the envelope
is valid. Invalid/unreadable envelopes use the inherited `OUTPUT_DIR`.
If output itself is unusable, manifest export is impossible and an explicit
stderr diagnostic is emitted. Configuration diagnostics are redacted, never
raw parser/IO errors or JSON snippets. Manifests contain no environment, paths,
credentials, or raw errors. Npm/test stdout and stderr are inherited unchanged;
apps must manage their own log redaction. SIGKILL/container deletion cannot
produce a final manifest.

Reporters own their raw Allure directories; this launcher neither merges nor
generates reports and does not change artifact directory ownership. The image
retains the upstream default root execution for compatibility with existing
platform runners that copy runtime files. It is not a sandbox for untrusted
websites. Consumers requiring non-root execution must provision writable app,
secret, and artifact paths and select the upstream `pwuser` explicitly.

Orchestrators should check the contract label before consumption, mount the
envelope and artifacts, set `ONECX_RUNTIME_FILE`, and use inherited ENTRYPOINT.
Overriding ENTRYPOINT with `node` bypasses this contract and is not supported
for contract-aware execution.

## Build, verify, and publish

```shell
node --test tests/*.test.cjs
docker build -t onecx-playwright:local .
docker run --rm onecx-playwright:local sh -c 'node --version'
docker build -f tests/Dockerfile -t onecx-playwright-smoke:local .
sh tests/launcher.sh
```

The smoke consumer uses its own lockfile and launches Chromium, Firefox, and
WebKit without external app services. The GitHub workflow validates before
publishing to `ghcr.io/<repository-owner>/<repository-name>`. PRs only build/test;
main publishes a moving development tag and SHA tag. A `v0.0.2` tag publishes
`0.0.2`, without a `latest` tag. Configure package access so consuming CI can pull
it; do not use the moving main tag for reproducible matrix runs.

Runtime upgrades require updating the upstream Playwright tag and digest,
`ONECX_PLAYWRIGHT_VERSION`, smoke dependency and lockfile together. Update the
Node stage tag/digest and workflow version together, bump the runtime release, and verify
all three browsers. Consumers then update their runtime reference and runner
lockfile and rebuild/publish their app E2E images.

This repository does not automatically migrate or publish consuming app images.
Shared layers and build caches may speed builds/pulls across app repositories;
test execution and login speed are unchanged.

### Release 0.0.2 (unpublished)

Introduces contract label v1, the shared Node launcher, runtime envelope
validation, config confinement, CA/output validation, signal forwarding, and
safe execution manifests. Consumers must provide a readable Playwright config
and npm scripts accepting Playwright CLI arguments. Config overrides now use
the envelope or `ONECX_PLAYWRIGHT_CONFIG`, not forwarded `--config` arguments.
Node and Playwright versions are unchanged. Publish only after the workflow's
unit and inherited consumer Docker smoke checks pass; no release is published
by these local changes.
