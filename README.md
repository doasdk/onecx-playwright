# OneCX Playwright runtime

A thin shared base image for OneCX app-specific E2E images. The root
`versions.json` defines the release, pinned Node and Playwright images, and
orchestration dependencies. The runtime provides browsers and OS dependencies
on Ubuntu Noble, Node, npm, and an inherited test launcher. The initial supported image
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
FROM ghcr.io/doasdk/onecx-playwright:0.0.4

COPY integration/package.json integration/package-lock.json ./
# Required only while the app consumes a vendored common-package archive.
COPY integration/vendor/ ./vendor/
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund

COPY integration/e2e/ ./e2e/
COPY integration/playwright.config.ts integration/tsconfig.json ./
```

Do not copy the app's old `docker-entrypoint.sh` or redeclare its ENTRYPOINT:
inherit this image's launcher. Keep `@playwright/test` pinned to the version derived
from `playwrightImage` in the root `versions.json` (also generated in `tests/smoke/package.json`) in the
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
node scripts/versions.mjs check
node --test tests/*.test.cjs scripts/*.test.mjs
docker build -t onecx-playwright:local .
docker run --rm onecx-playwright:local sh -c 'node --version'
docker build -f tests/Dockerfile -t onecx-playwright-smoke:local .
sh tests/launcher.sh
```

The smoke consumer uses its own lockfile and launches Chromium, Firefox, and
WebKit without external app services. The GitHub workflow validates before
publishing to `ghcr.io/<repository-owner>/<repository-name>`. PRs only build/test;
main publishes a moving development tag and SHA tag. A `v<release>` tag publishes
`<release>`, `<release>-orchestrator`, and `<release>-agent-runtime`, without a `latest` tag. Configure package access so consuming CI can pull
it; do not use the moving main tag for reproducible matrix runs.

### Single-source version updates

The root `versions.json` is the only release/dependency input. Node and
Playwright semantic versions are derived from their full image tags and digests,
not maintained separately. Change a release with one command:

```shell
node scripts/versions.mjs release <new-semantic-version>
```

For dependency/runtime updates, edit `nodeImage`, `playwrightImage`,
`integrationTests`, `allure`, `claudeCode`, or `playwrightMcp` in `versions.json`, then run:

```shell
node scripts/versions.mjs sync
node scripts/versions.mjs check
```

`sync` generates the checked-in `Dockerfile` from `scripts/Dockerfile.template`,
`.node-version` (consumed by setup-node), and npm manifests. It runs
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` **only**
for changed npm manifests. Commit generated files and resulting locks together;
direct `docker build` needs no generator or network preparation step.
`check` (also `--check`) is read-only and offline: it verifies generated files,
lock metadata, installed direct dependency versions, aligned Playwright/browser
tooling versions, and public registry URLs.
A stale lock with an unchanged manifest is rejected rather than silently
regenerated; repair it using that same npm command in the reported directory.

The independent safety baseline in
`orchestrator/compatibility/compatibility.json` is **not** release metadata.
Integration dependency changes are rejected until maintainers review all four
adapters against the new package, verify their source-shape guards, and explicitly
update that baseline. Neither `sync` nor `release` changes it automatically.
Then run the tests and both image smoke checks, including all three browsers,
before tagging/publishing. Consumers update their runtime and Playwright runner
lockfile and rebuild/publish their app E2E images.

Examples use `<release>` and `<release-tag>` intentionally: replace them with
`release` from `versions.json` and `v` plus that value, or a published immutable
commit/digest. Resolve the matching Playwright runner from
`tests/smoke/package.json`; examples are templates, not current-release snapshots.
The versions in `tests/launch.test.cjs` and `tests/validate-runtime.test.cjs`
are synthetic matching/mismatching runtime fixtures, not maintained release pins.

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

### Separate orchestrator rollout (unpublished)

The runtime retains contract 1 and its inherited launcher. The rollout adds a separately tagged
orchestrator and a reusable workflow. Neither image is claimed to be published
by these changes. Pass both image smoke checks before creating the release tag.
No changes or new release of `onecx-integration-tests` are required.

## Separate orchestration image

Build `--target runtime` for application E2E images; an unqualified build also
produces the runtime. Build `--target orchestrator` for the separate
`<release>-orchestrator` variant. It inherits the browser layers deliberately for a
single maintained OS/Node base; this trades image size for simpler maintenance.
Only the orchestrator adds Docker CLI, Java (Allure), and the pinned
repository-owned runner, published `@onecx/integration-tests`, and
`allure-commandline` at the exact versions in `versions.json`. Its private manifest and genuine npm registry lockfile live in
`/opt/onecx-orchestrator`, outside consumer manifests and module resolution.
It installs neither the common E2E package nor application tests.
It clears the inherited Playwright launcher contract label and advertises
`org.onecx.orchestrator.contract="1"` instead: do not use this variant as
`test.image`.

```shell
docker build --target orchestrator -t onecx-orchestrator:local .
docker run --rm onecx-orchestrator:local --help
```

Its ENTRYPOINT runs `node /opt/onecx-orchestrator/runner/index.mjs` (the tooling
manifest also names this CLI `onecx-it`); commands are `validate`, `matrix`, `run`,
`run-matrix`, and `report`, with `--config <path>`, optional
`--selection <base64>`, `--results <path>`, and `--work <path>`.
`MATRIX_SELECTION_BASE64` is an alternative selection input. `matrix` writes
only JSON `{ "include": [{ "runId", "name", "testImage", "selectionBase64" }] }`
to stdout. `ONECX_MATRIX_INDEX_FILE` selects the report input index file,
defaulting to `results/matrix-index-input.json`; retain it between matrix and
report jobs. `E2E_IMAGE` can override `test.image`.

The orchestrator uses the Docker socket only for `run`/`run-matrix`, never
`validate`, `matrix`, or `report`. Access to that socket grants daemon-level
privileges: run only trusted config, repositories, images, and tests.

### Runner ownership and local validation

The shared CLI is maintained in `orchestrator/runner` in this image repository.
It wraps the existing published integration API; consumers do not install an
unpublished npm CLI. Versioned compatibility adapters in
`orchestrator/compatibility` are applied during the image build, keeping these
changes centralized and reviewable rather than modifying the upstream package
repository or duplicating application patches. They are coupled to the locked
supported dependency baseline in `orchestrator/compatibility/compatibility.json`
and must be reviewed and retested before that baseline changes.
The run-context adapter also makes the package's platform metadata and CA
exports honor `E2E_BASE_DIR`, matching the runner's configured work directory.

Run `npm ci --prefix orchestrator --omit=dev --ignore-scripts --no-audit --no-fund`
then `node orchestrator/runner/index.mjs --help` to validate the shared source
locally. Run `node --test tests/*.test.cjs orchestrator/runner/*.test.mjs` and
the image smoke commands from `.github/workflows/image.yml` before publishing.
Both image variants are built and checked on PRs without requiring a new
integration-package publication. Runtime builds never install these
orchestration dependencies or compatibility adapters.

### Local platform runs using the same image-owned launcher

On a Linux Docker host, extract the launcher from the pinned image instead of
copying orchestration scripts into each application repository. Run from the
application checkout:

```shell
export ORCHESTRATOR_IMAGE=ghcr.io/<owner>/onecx-playwright:<release>-orchestrator
export CONFIG_PATH=integration/integration.config.json
mkdir -p .onecx-ci
id=$(docker create "$ORCHESTRATOR_IMAGE")
docker cp "$id:/opt/onecx-orchestrator/workflow-launch.sh" .onecx-ci/launch.sh
docker rm "$id"
sh .onecx-ci/launch.sh matrix
export RUN_ID=$(node -p 'require("./.onecx-ci/matrix.json").include[0].runId')
export MATRIX_SELECTION_BASE64=$(node -p 'require("./.onecx-ci/matrix.json").include[0].selectionBase64')
sh .onecx-ci/launch.sh run
sh .onecx-ci/launch.sh report
```

The example runs only the first matrix entry; execute every entry before
expecting a complete combined report. Set optional `E2E_IMAGE` and runtime
`ENVIRONMENTS_JSON`/`TEST_DATA_JSON` through your secret manager or shell
environment, never literal credentials in saved commands. Existing
`DOCKER_CONFIG` authentication is copied privately when present. The launcher
uses the same daemon-visible volume paths, private logs, result export and
cleanup as CI. It supports `matrix`, `run`, and `report`; it is not a second
implementation of platform orchestration. Concurrent local invocations have
isolated secret/log state but must use distinct result locations/checkouts
and RUN_IDs to avoid overwriting the shared matrix output or report files.
The host launcher uses Linux Docker host networking; these instructions do
not claim native Windows Docker Desktop support.

## Reusable caller workflow

The caller needs only its platform configuration, integration config, tests/
E2E image build, and a tiny workflow call. No caller npm orchestration scripts
are used. Replace both placeholder references with published immutable
versions; image publication and workflow publication are separate prerequisites.

```yaml
name: Integration
on: workflow_dispatch
jobs:
  integration:
    uses: <owner>/onecx-playwright/.github/workflows/integration.yml@<commit-sha>
    with:
      orchestrator-image: ghcr.io/<owner>/onecx-playwright:<release>-orchestrator
      config-path: integration/integration.config.json
      e2e-image: ghcr.io/<owner>/<app>-e2e:<immutable-tag>
      environment: integration
      max-parallel: 2
      docker-registry: ghcr.io
    secrets:
      ENVIRONMENTS_JSON: ${{ secrets.ENVIRONMENTS_JSON }}
      TEST_DATA_JSON: ${{ secrets.TEST_DATA_JSON }}
      # Optional: only for an app-owned prompt-driven agent lane.
      AGENT_CONFIG_JSON: ${{ secrets.AGENT_CONFIG_JSON }}
      DOCKER_AUTH_CONFIG: ${{ secrets.DOCKER_AUTH_CONFIG }}
```

`orchestrator-image` is required: there is no hardcoded registry owner or
unpublished default. `config-path` defaults to
`integration/integration.config.json`, `e2e-image` is optional, and
`max-parallel` defaults to 2. Docker credentials are explicitly forwarded
optional secrets; public images need none. `DOCKER_AUTH_CONFIG` contains Docker
`config.json` JSON for the required registries, written privately before pulling
the orchestrator and copied privately into the run container. It supports
multiple registries without any credentials in workflow source.
Legacy `docker-username`/`docker-password` for `docker-registry`, and lowercase
application secret aliases, remain accepted; prefer the uppercase interface
above and do not supply both authentication mechanisms.
They must permit pulling the orchestrator, platform, and application images.
`ENVIRONMENTS_JSON` and `TEST_DATA_JSON`
are opaque application JSON objects, also accepted by the package CLI through
their `*_FILE` settings; the workflow passes secret files using `docker cp`.

### Shared reusable browser agent (0.0.4)

The optional `agent-runtime` Docker target inherits `runtime`, including contract
label 1, the entrypoint, and its default command. It adds locked Claude Code and
Playwright MCP dependencies under `/opt/onecx-agent`, runs the native Claude
installer explicitly after `npm ci --ignore-scripts`. The live browser is launched
by the application's injected Playwright Chromium using the browser already
installed in the base runtime; MCP attaches over CDP and needs no additional
browser installation. Agent tests and
`node_modules` from the checkout are excluded from the build context.
The ordinary runtime and orchestrator remain separate and unchanged.
When running as root, the agent explicitly disables Chromium's sandbox; non-root
execution retains it. Run this lane only against trusted integration targets in
an isolated environment, never as a sandbox for untrusted sites or prompts.

A new application supplies configuration, prompts, a thin Playwright fixture,
and a handwritten Playwright test; it does not copy the shared agent loop.
Its existing common-e2e `authenticatedPage` fixture performs login and navigation
using an overridden shared live `page`/`context`. After application-specific
readiness checks, the test passes that exact authenticated Page to the agent.
See `examples/browser-agent` for the fixture/spec wiring.
The application still supplies its locked `@playwright/test` dependency matching
the ordinary runtime and readable `playwright.config.ts`, as required by the
inherited launcher. For example, add to its integration package:

```json
{
  "scripts": {
    "tests:agent": "playwright test --config=agent/playwright.config.ts"
  }
}
```

```dockerfile
FROM ghcr.io/doasdk/onecx-playwright:0.0.4-agent-runtime
COPY integration/package.json integration/package-lock.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY integration/ ./
# The inherited launcher appends --config /app/integration/playwright.config.ts.
COPY integration/agent.playwright.config.ts ./playwright.config.ts
```

Keep the inherited ENTRYPOINT. Set the integration config's `test.script` to
`tests:agent` and `test.image` to this consumer image. A minimal
`agent.config.json` is:

```json
{
  "schemaVersion": 1,
  "prompt": "./prompts/check-navigation.md",
  "requiredChecks": ["navigation"],
  "requiredTools": ["browser_snapshot", "browser_click"]
}
```

The configuration contains exactly the four keys above. Prompt paths resolve
relative to the agent config; absolute paths, directory escapes, and escaping
symlinks are rejected. `requiredChecks` names the exact
checks the report must satisfy; `requiredTools` lists required Playwright MCP
browser tool names (`browser_snapshot`, `browser_click`, or
`browser_wait_for`). Check names are unique lowercase identifiers, starting with
a letter and containing only letters, digits, underscores, and hyphens.
Required tools must have actual successful calls recorded by the shared MCP
execution trace; model-only claims or fabricated tool results cannot satisfy
this requirement. CLI initialization errors fail safely with a nonzero exit.
Prompts describe application behaviour, not credentials. The model must never
navigate, reload, open/close tabs, create contexts, attempt login, or change
application data. A visible login form is inconclusive, not permission to log in.
Only the selected safe tools are advertised and accepted by the MCP shim; Claude
also has an explicit tool allowlist. Clicks can still trigger navigation or data
changes, so these guardrails are not a security sandbox.

The shared CommonJS bridge `/opt/onecx-agent/playwright.cjs` exports:

```js
const live = await createLiveBrowser({ chromium, contextOptions, env })
// Returns { page, context, cdpEndpoint, close }.
// Override the existing authenticatedPage fixture's page/context dependencies,
// let it log in and navigate, then verify application readiness.
const result = await runBrowserAgent({
  page: authenticatedPage,
  cdpEndpoint: live.cdpEndpoint,
  configPath,
  env,
  secrets: []
})
// result is numeric 0 or 1. In fixture finally: await live.close().
```

Before `createLiveBrowser`, call
`initializeAgentReport({ configPath, env })` in the fixture. This additional
bridge export returns `Promise<void>` and clears stale passes with an
inconclusive report for the configured checks before login/setup can fail.
All runtime APIs use the same output resolution: explicit `env.OUTPUT_DIR`,
otherwise `/OUTPUT_DIR`. Use one explicit writable directory throughout.

For new consumers, `createAgentFixtures({ chromium, configPath, outputRoot })`
returns the fixture overrides for `baseTest.extend(...)`, including
`liveBrowser` and `agentEnvironment`. It handles report initialization and browser
cleanup; the existing authenticated fixture still owns credentials and login.
The low-level APIs above remain available. Wrap the invocation and success
assertion in `recordAssessment(page, testInfo, callback)` for agent-phase video
on every run and screenshots on failure. Mark the test with `agent-prepared`
after deterministic readiness.

Allure reporting is provided by `/opt/onecx-agent/allure-reporter.cjs`, with
options `{ outputRoot, requiredChecks, suite }`. It derives names/history from
the caller's test title/ID, attaches per-check evidence and allowed media, and
never copies raw login/helper attachments or process logs. The generic fixture,
reporter, Allure SDK, and recording helpers ship in the shared image; do not
copy them into each consumer. See `examples/browser-agent` for the agent-only
configuration. The root `agent.playwright.config.ts` used in the Docker example
is a one-line re-export: `export { default } from './agent/playwright.config'`.
Video and screenshots can contain application data; keep artifact access restricted.

Set `ONECX_AGENT_RUNTIME_DIR` for a local bridge location. `chromium` is the
consumer's Playwright browser type. Context options, including HTTPS handling,
are retained. The browser uses a private persistent default profile beneath
`OUTPUT_DIR` and an ephemeral CDP endpoint bound to `127.0.0.1`; do not publish
that port. MCP uses `--cdp-endpoint` and the page's origin without launching a
browser, importing storage state, or navigating. Exactly one context and one
ready HTTP(S) page are required. CDP browser endpoint, page target ID, document
loader ID, and URL are checked before/after model execution. The same DOM,
sessionStorage, and JavaScript SDK memory remain alive throughout the handoff.
No DOM marker or page script is inserted for identity validation.

The application owns authentication and readiness. It never gives login
credentials to Claude or MCP. `secrets` supplies known values only for in-process
report redaction, not prompts or subprocess configuration. Only Claude receives
model tokens. The browser and MCP receive minimal environments. The live fixture
must remain open until the agent returns; MCP disconnect does not close the
caller-owned browser. Fixture teardown closes it and deletes the private
profile. Private execution files are cleaned after the model run.

There is no standalone agent CLI or authentication adapter. Run the same
handwritten Playwright spec locally using the consumer's existing configuration,
with model configuration supplied by a secret manager and application login
settings available only to its existing trusted fixtures:

```shell
npm ci --prefix agent --ignore-scripts --no-audit --no-fund
node agent/node_modules/@anthropic-ai/claude-code/install.cjs
# In the consumer integration directory, using its installed browser:
npm run tests:agent
```

The shared model-free regression suite (`node --test agent/*.test.mjs`) uses the
locally installed shared Playwright browser for a synthetic MCP snapshot/click
test. That development-only browser is not required in the runtime image.
Disable consumer traces, screenshots, video, and authentication-bearing logs
for this suite; do not export hidden profile/execution directories.

For CI, call the reusable workflow at `@v0.0.4` with a separate agent integration
config and images selected by `vars.AGENT_ORCHESTRATOR_IMAGE` and
`vars.AGENT_E2E_IMAGE`:

```yaml
jobs:
  agent:
    uses: doasdk/onecx-playwright/.github/workflows/integration.yml@v0.0.4
    with:
      config-path: integration/agent.integration.config.json
      orchestrator-image: ${{ vars.AGENT_ORCHESTRATOR_IMAGE }}
      e2e-image: ${{ vars.AGENT_E2E_IMAGE }}
      artifact-prefix: agent
    secrets:
      ENVIRONMENTS_JSON: ${{ secrets.ENVIRONMENTS_JSON }}
      TEST_DATA_JSON: ${{ secrets.TEST_DATA_JSON }}
      AGENT_CONFIG_JSON: ${{ secrets.AGENT_CONFIG_JSON }}
```

Pin `AGENT_ORCHESTRATOR_IMAGE` to `0.0.4-orchestrator` (prefer a digest) and
`AGENT_E2E_IMAGE` to the immutable application agent image. Configure registry
authentication when needed, just as for deterministic runs.
`artifact-prefix` defaults to `integration`, preserving existing artifact names;
use distinct prefixes when deterministic and agent calls run in one workflow.
This namespaces the matrix index, run, private, combined report, and download
selection without changing result paths or matrix IDs.

Deterministic tests are unchanged when `AGENT_CONFIG_JSON` is absent; the workflow
does not select an agent lane automatically.

The reusable workflow accepts the optional **secret** `AGENT_CONFIG_JSON`:

```json
{
  "anthropicBaseUrl": "https://model-gateway.example/anthropic",
  "model": "your-enabled-model",
  "authToken": "<runtime-secret>",
  "extraCaCertPem": "<optional PEM certificate bundle>"
}
```

Required fields are `anthropicBaseUrl`, `model`, and **exactly one** of
`authToken` or `apiKey`. `extraCaCertPem` is optional; omit it when unused.
Additional fields, empty strings, NUL characters, URL credentials/fragments,
and non-HTTPS model endpoints are rejected, including loopback HTTP endpoints.
Application target URLs may still use HTTP for local integration testing.
PEM content is consumed privately by the agent process, not
installed into the shared image trust store.
The orchestrator and shared agent apply the same provider validation: use an HTTPS endpoint
without query parameters, a model identifier (letters, digits, `.`, `_`, `:`,
`/`, and `-`), a credential without line breaks, and a valid PEM certificate
bundle when configured.

Only the selected `run` job receives this secret. The host launcher writes a
mode-600 private file, copies it to the orchestrator's private volume, forwards
only `AGENT_CONFIG_JSON_FILE`, and deletes the host file on cleanup. The runner
accepts either `AGENT_CONFIG_JSON` or `AGENT_CONFIG_JSON_FILE` (relative file
paths resolve from the integration config directory), never both nonempty.
Validation errors are generic and never include secret values. The validated
JSON is forwarded verbatim as `environment.AGENT_CONFIG_JSON` in the private
contract-1 runtime envelope; the legacy compatibility bootstrap also supports
the explicit setting. No arbitrary host environment forwarding is added.
Do not pass it as a workflow input, Docker argument, build secret, image layer,
or test archive. App stdout remains private runner logging; the app must never
print credentials.

The agent writes `/e2e-results/agent-report.json` with exactly:

```json
{
  "schemaVersion": 1,
  "verdict": "passed",
  "summary": "Completed the requested navigation checks.",
  "checks": [
    { "name": "navigation", "verdict": "passed", "evidence": "Expected page heading was visible." }
  ]
}
```

All fields are required. Verdicts are `passed`, `failed`, or `inconclusive`;
summary/evidence are strings, names are nonempty strings, and checks is an
array. Unknown keys at either level, invalid JSON, nonregular files/symlinks,
and reports over 1 MiB are rejected with a generic error, failing the run
without publishing that file. The exporter reconstructs only this public
shape and redacts exact configured credential/CA strings from free text.
The producer must still supply **public, sanitized text**: shape validation
cannot identify arbitrary secrets embedded in prose. Never put raw model
transcripts, browser auth/storage state, cookies, headers, or credentials in
this report. Neither raw transcripts nor auth state are added to public exports.
Existing private-artifact opt-ins are unchanged and remain sensitive.

The sanitized report is exported as `results/<RUN_ID>/agent-report.json` and
included in both run and combined workflow artifacts, also for normal nonzero
test exits. A missing report is allowed and creates no placeholder; verdicts
do not override the existing container/`execution.json` status contract. The
agent API returns `1` when required checks/tools or its policy fail; the consumer
Playwright test must assert the returned value is `0`, making its test exit fail.
Publish the updated orchestrator image and pin both the reusable workflow
revision and that image before consuming this optional interface.

All three jobs select the caller repository environment named by the
`environment` input (default `integration`), preserving its secret/variable
scope and protection rules. Environment secrets override passed secrets with
the same names. Set `ORCHESTRATOR_IMAGE` and optional `E2E_IMAGE` as repository
variables or environment variables; a nonempty explicit image input wins, with
job-level environment variables used when the caller's expression resolves
empty before environment selection. The required orchestrator input must
still be present in the call. Environment approval rules can apply to each
matrix/report job. Existing application E2E images may remain on runtime
`0.0.2`; this workflow change does not require migrating their compatible
contract-1 launcher or publishing them again.

An integration config has this shared schema (paths relative to this file;
editor schema: `orchestrator/config.schema.json`):

```json
{
  "schemaVersion": 1,
  "platform": { "config": "./platform.json" },
  "test": {
    "image": "ghcr.io/<owner>/<app>-e2e:<immutable-tag>",
    "script": "tests:gui",
    "timeoutMs": 1800000
  },
  "matrix": { "ui.shell": ["<immutable-image-ref>"] },
  "components": { "ui.shell": "shell-ui" },
  "environment": "container",
  "artifacts": { "capturePrivate": false }
}
```

`test.image` is required even if CI overrides it. Component keys and aliases
must match the platform configuration. `matrix` also accepts a relative JSON
path, for example `"matrix": "./versions.json"`, keeping version selection in
a separate caller-owned file. See `examples/next-app` for a non-Workspace
consumer, required `ORCHESTRATOR_IMAGE` repository variable, pinned local
image commands, and publication order. `tests/orchestrator` is a minimal
configuration-only consumer for image validation; the existing `tests/smoke`
remains the inherited browser/runtime consumer.

An optional `extends` selects another integration config, not an agent scenario
config. For example, an agent lane reuses the deterministic lane's platform,
matrix, component aliases, environment, and artifact policy without duplication:

```json
{
  "schemaVersion": 1,
  "extends": "./integration.config.json",
  "test": {
    "image": "ghcr.io/<owner>/<app>-e2e-agent:<immutable-tag>",
    "script": "tests:agent",
    "timeoutMs": 1800000
  }
}
```

Inheritance supports chains and replaces **whole top-level sections**; it does
not deep-merge objects or concatenate arrays. Supplying `test` replaces all base
test settings, so explicitly retain any required timeout or base URL. Omitted
sections inherit; explicit values (including invalid/null values) replace and
are validated normally. Each file requires `schemaVersion: 1`. Extended configs
and their bases reject unknown top-level keys; standalone configs retain their
existing tolerance. Missing files, invalid JSON, and cycles fail validation.
`extends` resolves relative to the file declaring it. Inherited `platform.config`
and matrix file paths retain their declaring file's directory, even when the
child lives elsewhere; platform-internal paths still resolve from the platform
file. Runtime secret-file options remain relative to the selected child config.
The normalized runner config contains no `extends` field.

All commands (`validate`, `matrix`, `run`, `run-matrix`, `serve`, `report`) use
this same loader. The workflow stages the whole checkout, including base configs;
keep all referenced configs/platform data inside that checkout for CI.
The launcher sets `ONECX_CONFIG_SOURCE_ROOT` to the staged checkout: selected
configs, inherited configs, platform files, and matrix files must stay within
that directory, including after resolving symlinks. Direct local CLI calls
remain unrestricted unless this optional boundary is set.
Publish a **new** orchestrator image containing this loader before selecting an extended
config, and pin the consuming workflow/image to that release. Already-published
images do not gain inheritance support; do not overwrite existing release tags.
Existing standalone configs and their runtime compatibility remain unchanged.

The reusable workflow checks out the **caller** with checkout credential
persistence disabled. It extracts the shared launcher from the explicitly
selected orchestrator image, so tooling cannot accidentally resolve from the
caller or a moving shared branch. Each invocation creates a unique Docker
volume and mounts it at its daemon-reported absolute Mountpoint inside the
orchestrator. Nested test/service bind mounts therefore refer to the same
daemon-visible paths, without assuming the runner workspace exists in a
sibling container. Standard Linux Docker daemons are required. Only the run
orchestrator uses Linux host networking, so platform import/probes can reach
daemon-published service ports. Test/service container networking and aliases
remain owned by the shared package; matrix/report use neither host networking
nor the socket.
For private GHCR images, both the caller and reusable workflow must declare
`packages: read`; a reusable workflow cannot increase the caller's token
permissions. Pass `github.actor` as `docker-username` and `secrets.GITHUB_TOKEN`
as `docker-password`, and grant the caller repository Actions read access on
each private package. A registry login alone does not verify package access.
The selected matrix `runId` is passed as `RUN_ID` so report-index entries match
the exported directories. `TMPDIR` also points inside the daemon-visible
volume, keeping package-created secret/config scratch paths mountable.
Launcher logs and secret staging use a newly created per-process directory;
an existing directory is rejected rather than overwritten.

Matrix JSON becomes a job output; its report index is preserved as an artifact.
Each selected job exports `results/<RUN_ID>/summary.json`, `versions.json`,
`execution.json`, `allure-results`, and `allure-report`, including on failure.
The always-running report job downloads the index and run artifacts before
invoking the shared `report` command without the Docker socket. Summary and
report artifacts have seven-day retention. Runtime secrets, Docker credentials,
and raw service/test logs are not uploaded or printed by the launcher.
To intentionally publish package-captured private files, enable both config
`artifacts.capturePrivate` and workflow input `upload-private-artifacts`.
The latter defaults to false and uploads only the `private`/`private-artifacts`
directories to a separate `private-integration-run-*` artifact, never merged
into the report job. This can expose sensitive application data; restrict
artifact/repository access and review tests before opting in.
Allure attachments can contain application data: keep private capture disabled
and ensure test reporters respect that setting. Cleanup exports results,
removes the container and volume, and deletes local secret files. Like any CI
cleanup, it cannot run after runner loss or SIGKILL.
Stop/export/removal failures produce explicit redacted diagnostics and fail an
otherwise successful launch. When execution already failed, cleanup preserves
that original exit code instead of replacing it.
