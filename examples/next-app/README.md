# Next application integration consumer

This configuration-only example has no Workspace-specific routes, data, or
orchestration scripts. It is a template, not a runnable deployed platform.

1. Copy the `integration` directory and `.github/workflows/integration.yml`
   to the next application's repository.
2. Replace the minimal `integration/platform.json` with the application's full
   platform configuration in the shared integration package's
   platform format. Use network aliases matching the `components` map. Keep
   platform credentials and application data out of committed configuration.
3. Replace the example image references with published immutable images. The
   application's E2E image inherits the **runtime**, not the orchestrator.
   Keep its Playwright runner pinned to the version derived from the root
   `versions.json` Playwright image (see `tests/smoke/package.json`) and retain its existing tests/fixtures.
4. Replace the workflow owner and `@<release-tag>` with the actual published shared
   workflow release or commit SHA. Do not select `@main` for reproducible runs.
5. Set the required repository variable `ORCHESTRATOR_IMAGE` to the published
   `<release>-orchestrator` image, preferably by digest. Resolve `<release>` from
   the root `versions.json`, and `<release-tag>` as `v` plus that value.
   Configure explicitly passed
   secrets only when the platform/application/images need them.
   The reusable jobs select the caller's `integration` environment by default;
   change the `environment` input if needed. Store `ENVIRONMENTS_JSON`,
   `TEST_DATA_JSON`, and Docker `config.json` contents as `DOCKER_AUTH_CONFIG`
   there or as explicitly forwarded repository secrets. Environment-level
   `ORCHESTRATOR_IMAGE` and `E2E_IMAGE` variables are resolved inside those jobs.
   Existing compatible app images may keep their runtime base; new runtime
   consumers opt into the selected release.

The shared workflow defaults `config-path` to the path above. `e2e-image` is an
optional workflow override of the required configured `test.image`.
`matrix: "./versions.json"` resolves relative to `integration.config.json`.
CI invokes the shared image directly; do not copy the host launcher here.

For local configuration checks with the published orchestrator image:

```shell
docker run --rm --mount "type=bind,src=$PWD,dst=/consumer,readonly" "$ORCHESTRATOR_IMAGE" validate --config /consumer/integration/integration.config.json
docker run --rm --mount "type=bind,src=$PWD,dst=/consumer,readonly" "$ORCHESTRATOR_IMAGE" matrix --config /consumer/integration/integration.config.json --results /results
```

Use absolute bind paths; on PowerShell replace `$PWD` with its absolute
directory value. Actual platform runs also require daemon-visible paths and
the Docker socket: use the shared workflow rather than copying its launcher.
For source development of the central runner, follow the root README.
For local platform execution, follow its “Local platform runs” section: extract
`workflow-launch.sh` from the exact selected image and invoke it, rather than
maintaining application-owned copies or installing a new npm wrapper.

Release order: validate and publish runtime `<release>` plus `<release>-orchestrator`;
publish/pin the shared workflow
revision; build/publish the application E2E image; finally configure and run the
consumer. Existing compatible application images do not require rebuilding.
The runner uses the published integration package pinned in the root `versions.json`: no upstream
package change or new npm release is required. None of these publications is
performed by this example.
