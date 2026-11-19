# Shared live authenticated Page runtime

Load `playwright.cjs` from an application-owned Playwright Test fixture:

```js
const { createLiveBrowser, runBrowserAgent } = require('/opt/onecx-agent/playwright.cjs')
const live = await createLiveBrowser({ chromium, contextOptions, env: process.env })
try {
  // Override common-e2e page/context with live.page/live.context, then let its
  // existing authenticatedPage fixture log in, navigate, and verify readiness.
  const code = await runBrowserAgent({
    page: authenticatedPage,
    cdpEndpoint: live.cdpEndpoint,
    configPath,
    env: process.env,
    secrets: []
  })
} finally {
  await live.close()
}
```

See `examples/browser-agent` for the actual fixture/spec wiring. `chromium` is
injected from the consumer's Playwright installation; the declaration preserves
that installation's inferred page/context types rather than requiring matching
Playwright versions. `runBrowserAgent` returns numeric `0`/`1` and replaces
`OUTPUT_DIR/agent-report.json`, including on setup and model failures.

For consumers, prefer `baseTest.extend(createAgentFixtures({
chromium, configPath, outputRoot }))` over copying the lifecycle above.
`createAgentFixtures` exports `liveBrowser`, `agentEnvironment`, `context`, and
`page` fixtures. It initializes the report before authentication, supplies the
same output environment, preserves the existing login fixture, and closes the
browser in `finally`. The consumer only supplies the fixture import and
application-specific navigation/readiness assertions.

Wrap the agent invocation and its exit-code assertion in
`recordAssessment(page, testInfo, async () => { ... })`. This records WebM on the
existing page after authentication, always attaches video, and attaches a
password-input-masked PNG if the callback throws. Recording/attachment errors
fail explicitly. No login video is recorded when called after readiness.
Unexpected login redirects and application data may still appear in the video;
use synthetic accounts and restrict report access. Media are not sent to the model.

Configure `/opt/onecx-agent/allure-reporter.cjs` as a Playwright reporter with
`{ outputRoot, requiredChecks, suite }`. It uses the test title/ID (not any
application-specific names), writes per-check evidence and summary, and exports
only the public assessment plus explicitly named media. Set the
`agent-prepared` test annotation after readiness. Failed observations are failed;
inconclusive/setup/runtime failures are broken. No raw Playwright errors,
login-helper attachments, or transcripts are copied to Allure. The SDK,
fixture factory, media capture, and reporter are all shipped in the shared image.

Call `initializeAgentReport({ configPath, env })` at the start of the live-browser
fixture, before launching Chromium or running login. It returns `Promise<void>`
and replaces stale results with an inconclusive report containing the configured
required checks and `Authenticated browser preparation did not complete.`.
If consumer config is invalid, it retains an empty-check failure report before
rejecting. This ensures authentication/setup failures cannot leave a previous
passing report. All three APIs resolve output identically: `env.OUTPUT_DIR`,
falling back to `/OUTPUT_DIR`. Consumers should explicitly supply the same
writable `OUTPUT_DIR` throughout fixture and test execution.

This replaces the old CLI/authentication-adapter/storage-state contract.
There is no standalone agent CLI, state import, or authentication module.
Consumer config contains exactly `schemaVersion`, `prompt`, `requiredChecks`,
and `requiredTools`; prompt paths cannot escape its directory. Model-provider
configuration and budgets remain environment configured (`AGENT_CONFIG_JSON`
or `AGENT_CONFIG_JSON_FILE`, `AGENT_TIMEOUT_MS`, `AGENT_MAX_TURNS`).

## Live handoff and lifecycle

The fixture launches a persistent Chromium default context with a private
profile below `OUTPUT_DIR`, minimal environment, and an ephemeral loopback-only
CDP browser endpoint read from `DevToolsActivePort`. Context options such as
`ignoreHTTPSErrors` are preserved; debugging/profile overrides are rejected.
No CDP port is published. Root Linux containers use `--no-sandbox` and must be
trusted integration environments, not arbitrary-site browsing sandboxes.

MCP 0.0.85's pinned browser factory uses `connectOverCDP`, selects
`browser.contexts()[0]` without isolated mode, and initializes tabs from existing
`context.pages()`. The runtime requires exactly one context and one HTTP(S)
page, validates the endpoint's browser and page target, and compares CDP
target ID, loader ID, and URL before/after model execution. It does not insert
DOM markers, evaluate application code, reload, or navigate to prove identity.
Its real-browser test verifies the existing DOM, sessionStorage and JavaScript
memory survive MCP snapshot, click, and graceful disconnect.

Only `browser_snapshot`, `browser_click`, and `browser_wait_for` can be selected.
The MCP shim filters advertised tools and rejects other calls; Claude also has
only those tools allowed. Navigation, tabs, contexts, evaluation, shell, login,
and file-reading tools are unavailable. A click can still trigger navigation or
modify data: use trusted prompts and applications. Identity changes fail the
run; these constraints are not a security boundary or network firewall.

Only Claude receives model tokens. Chromium/MCP receive minimal environments,
never application credentials; known application secrets are used only for
in-process report redaction. Raw subprocess output is bounded in memory, never
published as transcripts. Private MCP output and Claude home are removed after
the run. MCP disconnect leaves the caller-owned browser alive; only fixture
teardown closes it and removes the profile. Do not publish hidden runtime
directories or consumer authentication traces.

Run validation without a model:

```sh
node --test agent/*.test.mjs
```

## Safe subprocess diagnostics

On a nonzero Claude exit, the public report may contain one of these fixed summaries:

- `Agent TLS certificate validation failed; check the configured model CA trust.`
- `Agent model authentication or authorization failed; check credentials and permissions.`
- `Agent model or endpoint was rejected; check the configured model and API endpoint.`
- `Agent model connection failed; check network connectivity and service availability.`
- `Agent model rate or quota limit was reached; check capacity and billing.`
- `Agent CLI arguments were rejected; check installed CLI compatibility.`
- `Agent MCP server startup failed; check browser MCP configuration and dependencies.`
- `Agent structured-output or tool-use compatibility failed; check model and API compatibility.`

These are diagnostic categories, not proof of a specific configuration defect. Classification
uses known stderr patterns first, then error text from the final stream-JSON result error.
Ordinary stdout, browser observations, and successful transcripts are not classified.
Unknown errors retain `Agent process did not complete successfully.`

Stdout and stderr share the existing in-memory output limit. Neither raw failure output nor
snippets, credentials, or endpoints are included in these summaries; no diagnostic transcript
is persisted. Output-budget and interruption failures take precedence over classification.
