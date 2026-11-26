# Live authenticated browser-agent example

Copy this folder as `integration/agent` into your integration tests. This is a handwritten Playwright
Test wrapper, not a login adapter or generated test suite. Adjust the common-e2e
fixture import to your application's existing authenticated fixture.

The shared runtime exports `createAgentFixtures`, `recordAssessment`, and `runBrowserAgent` from
`playwright.cjs`. Set `ONECX_AGENT_RUNTIME_DIR` locally; the container default is
`/opt/onecx-agent`. The application supplies its own Playwright `chromium`, so its
browser version and context options (including `ignoreHTTPSErrors`) are retained.

`live.fixture.ts` uses the shared factory to override `page` and `context`. Your existing common-e2e
`authenticatedPage` fixture still logs in, navigates, and establishes readiness.
The test passes **that same live Page** to the runtime. Customize the example's
readiness assertion to your application. No storage state is copied, no new
context or tab is created for MCP, and no credentials are given to the model.
Session storage, the DOM, and in-memory SDK state survive the handoff.
Before launching the browser, it calls `initializeAgentReport({ configPath, env })`
to replace stale passes with a known-check inconclusive result, including when
login or fixture setup fails. Supply the same explicit `OUTPUT_DIR` to every
runtime call; its shared fallback is `/OUTPUT_DIR`.

Use the provided agent-only `playwright.config.ts`. Add
`"tests:agent": "playwright test --config=agent/playwright.config.ts"` to the
consumer package. In its agent Docker stage, replace the root
`playwright.config.ts` with a re-export of `./agent/playwright.config` so the
inherited launcher's appended root `--config` still selects only the agent test.
Keep traces and automatic video/screenshots disabled. The shared
`recordAssessment` helper records only after readiness: video always,
screenshots on failed/inconclusive assessments. The shared Allure reporter is
configured by path; no reporter/media implementation is copied into this folder.
Change its `suite` label for your application. Reports use the fixed test's title
and identity automatically.

`configPath` is exported once by the local fixture and used by initialization and
execution; the reporter reads the same config's required checks.
Set `OUTPUT_DIR` to a private writable output directory. Set exactly one of
`AGENT_CONFIG_JSON_FILE` (recommended, read-only mounted secret) or
`AGENT_CONFIG_JSON` with model configuration:

```json
{
  "anthropicBaseUrl": "https://your-model-gateway.example",
  "model": "your-model-name",
  "authToken": "provided-at-runtime"
}
```

Use `apiKey` instead of `authToken` if required. Optional `extraCaCertPem` supplies
gateway CA trust. Application credentials remain solely in the trusted
application fixture. Pass known secret values in `secrets` only for in-process
report redaction; they are not added to model prompts, MCP files, or subprocess
environments.

Consumer configuration has exactly `schemaVersion`, `prompt`, `requiredChecks`,
and `requiredTools`. `prompt` is a file relative to the configuration directory;
absolute paths, directory escapes, and escaping symlinks are rejected. There is
no `authentication` module. Tools may only be `browser_snapshot`,
`browser_click`, and `browser_wait_for`. Choose only the tools actually needed.
Never ask the agent to navigate, reload, create tabs/contexts, log in, or change
application data. If authentication is no longer ready, report inconclusive.

The runtime writes `OUTPUT_DIR/agent-report.json`, returns `0` only for a
validated passed report with successful required tool calls, and otherwise
returns `1`. The fixture closes Chromium and removes its private profile only
after the agent returns. Do not retain or publish hidden runtime directories.
Browser observations can contain sensitive data: the constrained tools and
redaction are guardrails, not a security sandbox.

The base fixture import in `live.fixture.ts` and the navigation/readiness in the
spec must be adapted to your application. The body-visible assertion is only a
placeholder; require a recognizable authenticated application heading/content.
Use your fixture's credential values for redaction instead of the example
environment variable when appropriate. Keep model/application secrets out of
the image. See the Workspace consumer for typed bridge declarations and a full
platform/workflow integration; only application preparation and prompts belong
in the consumer.
