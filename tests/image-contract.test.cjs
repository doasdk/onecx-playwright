const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");

const root = path.resolve(__dirname, "..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "orchestrator/package.json")));
const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json")));
const playwrightVersion = versions.playwrightImage.match(/:v([^-]+)-/)[1];

test("should preserve Linux line endings in shell scripts copied into images", () => {
    for (const script of ["runtime/entrypoint.sh", "orchestrator/workflow-launch.sh", "tests/launcher.sh"]) {
        const source = fs.readFileSync(path.join(root, script), "utf8");
        assert.equal(source.includes("\r"), false, `${script} must use LF line endings`);
        assert.ok(source.startsWith("#!/bin/sh\n"), `${script} must have a Linux shebang`);
    }
});

test("should exclude installed dependencies and generated artifacts when staging a checkout", () => {
    const launcher = fs.readFileSync(path.join(root, "orchestrator/workflow-launch.sh"), "utf8");
    for (const directory of [
        "node_modules", ".angular", "dist", "integration-tests", "test-results",
        "playwright-report", "allure-results", "allure-report", "blob-report"
    ]) {
        assert.ok(launcher.includes(`--exclude=${directory}`), `${directory} must not be staged`);
    }
});

test("should isolate the pinned integration CLI from consumer dependencies", () => {
    assert.equal(manifest.private, true);
    assert.deepEqual(manifest.dependencies, {"@onecx/integration-tests": versions.integrationTests, "allure-commandline": versions.allure});
    assert.deepEqual(manifest.bin, {"onecx-it": "./runner/index.mjs"});
    assert.match(dockerfile, /WORKDIR \/opt\/onecx-orchestrator/);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
    assert.doesNotMatch(dockerfile, /npm install|onecx-common-e2e/);
});

test("should lock the published registry dependencies without local package paths", () => {
    const lockPath = path.join(root, "orchestrator/package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath));
    assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
    assert.equal(lock.packages["node_modules/@onecx/integration-tests"].version, versions.integrationTests);
    assert.equal(lock.packages["node_modules/allure-commandline"].version, versions.allure);
    assert.match(lock.packages["node_modules/@onecx/integration-tests"].resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.ok(lock.packages["node_modules/@onecx/integration-tests"].integrity);
    for (const entry of Object.values(lock.packages)) {
        assert.doesNotMatch(entry.resolved ?? "", /^file:/);
        assert.notEqual(entry.link, true);
    }
});

test("should retain the runtime default target and inherited launcher interface", () => {
    assert.match(dockerfile, /FROM runtime AS default-runtime\s*$/);
    assert.ok(dockerfile.includes(`ONECX_PLAYWRIGHT_VERSION=${playwrightVersion}\n`));
    assert.match(dockerfile, /ENTRYPOINT \["\/opt\/onecx-playwright\/entrypoint.sh"\]/);
    assert.match(dockerfile, /CMD \["tests:gui"\]/);
});

test("should distinguish the orchestrator contract from the app runtime contract", () => {
    const orchestrator = dockerfile.split("FROM runtime AS orchestrator")[1];
    assert.ok(orchestrator.includes(`org.opencontainers.image.version="${versions.release}-orchestrator"`));
    assert.match(orchestrator, /org\.onecx\.playwright\.contract=""/);
    assert.match(orchestrator, /org\.onecx\.orchestrator\.contract="1"/);
    assert.match(orchestrator, /ENTRYPOINT \["node", "\/opt\/onecx-orchestrator\/runner\/index.mjs"\]/);
    assert.match(orchestrator, /CMD \["--help"\]/);
});

test("should apply centrally owned compatibility adapters only inside the orchestrator", () => {
    const [runtime, orchestrator] = dockerfile.split("FROM runtime AS orchestrator");
    assert.doesNotMatch(runtime, /compatibility|npm ci|docker.io/);
    assert.match(orchestrator, /COPY orchestrator\/runner\/ \.\/runner\//);
    assert.match(orchestrator, /COPY orchestrator\/compatibility\/ \.\/compatibility\//);
    assert.match(orchestrator, /set -eu; for adapter in compatibility\/patch-\*\.mjs; do node "\$adapter"; done/);
});

test("should require an explicitly selected image in the reusable workflow", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/integration.yml"), "utf8");
    assert.match(workflow, /orchestrator-image:\s+description:[^\n]+\s+type: string\s+required: true/);
    assert.match(workflow, /config-path:\s+type: string\s+default: integration\/integration.config.json/);
    assert.match(workflow, /e2e-image:\s+type: string\s+default: ''/);
    assert.doesNotMatch(workflow, /ghcr\.io\/[^'\s]*onecx-playwright|npm (ci|install|run)|npx /);
});

test("should source shared tooling from the selected image rather than the caller checkout", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/integration.yml"), "utf8");
    assert.match(workflow, /docker cp "\$id:\/opt\/onecx-orchestrator\/workflow-launch.sh"/);
    assert.doesNotMatch(workflow, /uses: \.\//);
});

test("should forward agent configuration only as an optional run secret and publish only its public report", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/integration.yml"), "utf8").replaceAll("\r", "");
    const [beforeRun, afterRun] = workflow.split("\n  run:\n");
    const [runJob, reportJob] = afterRun.split("\n  report:\n");
    assert.match(beforeRun, /AGENT_CONFIG_JSON:\s+description:[^\n]+\s+required: false/);
    assert.doesNotMatch(beforeRun, /AGENT_CONFIG_JSON: \$\{\{/);
    assert.match(runJob, /AGENT_CONFIG_JSON: \$\{\{ secrets\.AGENT_CONFIG_JSON \}\}/);
    assert.doesNotMatch(reportJob, /secrets\.AGENT_CONFIG_JSON/);
    assert.equal(workflow.match(/results\/\*\*\/agent-report\.json/g).length, 2);
    assert.doesNotMatch(workflow, /results\/\*\*\/(transcript|storage-state|agent-config)/);
    assert.doesNotMatch(dockerfile, /AGENT_CONFIG_JSON|authToken|apiKey/);
});

test("should keep the next app example free of duplicated orchestration scripts", () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, "examples/next-app/integration/integration.config.json")));
    const versions = JSON.parse(fs.readFileSync(path.join(root, "examples/next-app/integration/versions.json")));
    const workflow = fs.readFileSync(path.join(root, "examples/next-app/.github/workflows/integration.yml"), "utf8");
    assert.equal(config.matrix, "./versions.json");
    assert.ok(Array.isArray(versions["ui.shell"]));
    assert.match(workflow, /orchestrator-image: \$\{\{ vars.ORCHESTRATOR_IMAGE \}\}/);
    assert.match(workflow, /integration.yml@<release-tag>/);
    assert.doesNotMatch(workflow, /@main|run:|npm |npx /);
});

test("should select the caller environment for secrets and variables in every job", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/integration.yml"), "utf8");
    assert.match(workflow, /environment:\s+description:[^\n]+\s+type: string\s+default: integration/);
    assert.equal((workflow.match(/environment: \$\{\{ inputs.environment \}\}/g) || []).length, 3);
    assert.equal((workflow.match(/inputs.orchestrator-image \|\| vars.ORCHESTRATOR_IMAGE/g) || []).length, 3);
    assert.equal((workflow.match(/inputs.e2e-image \|\| vars.E2E_IMAGE/g) || []).length, 3);
});

test("should support explicit multi-registry auth without printing credentials", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/integration.yml"), "utf8");
    assert.match(workflow, /permissions:\s+contents: read\s+packages: read/);
    assert.match(workflow, /DOCKER_AUTH_CONFIG:\s+description:[^\n]+\s+required: false/);
    assert.equal((workflow.match(/printf '%s' "\$DOCKER_AUTH_CONFIG" > "\$DOCKER_CONFIG\/config.json"/g) || []).length, 3);
    assert.equal((workflow.match(/run: rm -f "\$DOCKER_CONFIG\/config.json"/g) || []).length, 3);
    assert.match(workflow, /ENVIRONMENTS_JSON: \$\{\{ secrets.ENVIRONMENTS_JSON \|\| secrets.environments-json \}\}/);
    assert.match(workflow, /TEST_DATA_JSON: \$\{\{ secrets.TEST_DATA_JSON \|\| secrets.test-data-json \}\}/);
});

test("should publish private artifacts only with an explicit caller opt-in", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/integration.yml"), "utf8");
    assert.match(workflow, /upload-private-artifacts:\s+description:[^\n]+\s+type: boolean\s+default: false/);
    assert.match(workflow, /if: always\(\) && inputs.upload-private-artifacts/);
    assert.match(workflow, /name: private-\$\{\{ inputs.artifact-prefix \}\}-run-/);
    assert.match(workflow, /pattern: \$\{\{ inputs.artifact-prefix \}\}-\*/);
});

test("should namespace every workflow artifact while retaining the integration default", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/integration.yml"), "utf8");
    assert.match(workflow, /artifact-prefix:\s+description:[^\n]+\s+type: string\s+default: integration/);
    for (const suffix of ["matrix-index", "run-${{ matrix.runId }}", "report"]) {
        assert.ok(workflow.includes(`name: \${{ inputs.artifact-prefix }}-${suffix}`));
    }
    assert.doesNotMatch(workflow, /name: (?:private-)?integration-|pattern: integration-\*/);
});

test("should install isolated agent tooling without changing the inherited runtime launcher", () => {
    const agent = dockerfile.split("FROM runtime AS agent-runtime")[1].split("FROM runtime AS default-runtime")[0];
    assert.ok(agent.includes(`org.opencontainers.image.version="${versions.release}-agent-runtime"`));
    assert.match(agent, /WORKDIR \/opt\/onecx-agent/);
    assert.match(agent, /COPY agent\/package.json agent\/package-lock.json \.\//);
    assert.match(agent, /npm ci --ignore-scripts/);
    assert.match(agent, /node node_modules\/@anthropic-ai\/claude-code\/install.cjs/);
    assert.doesNotMatch(agent, /install-browser/);
    assert.match(agent, /COPY agent\/ \.\//);
    assert.match(agent, /WORKDIR \/app\/integration/);
    assert.doesNotMatch(agent, /ENTRYPOINT|CMD|org\.onecx\.playwright\.contract|docker\.io/);
    const ignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
    assert.match(ignore, /!agent\/\*\*/);
    assert.match(ignore, /^agent\/node_modules\/$/m);
    assert.match(ignore, /^agent\/\*\.test\.mjs$/m);
    assert.match(ignore, /^agent\/tests\/$/m);
});

test("should validate and publish all image variants without unpublished package prerequisites", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/image.yml"), "utf8");
    assert.match(workflow, /npm ci --prefix orchestrator/);
    assert.match(workflow, /node --test orchestrator\/runner\/\*\.test.mjs/);
    assert.match(workflow, /target: runtime/);
    assert.match(workflow, /target: orchestrator/);
    assert.match(workflow, /target: agent-runtime/);
    assert.match(workflow, /node --test agent\/\*\.test.mjs/);
    assert.match(workflow, /node agent\/node_modules\/playwright\/cli.js install --with-deps chromium/);
    assert.match(workflow, /suffix=-agent-runtime/);
    assert.match(workflow, /test "\$agent_version" = "\$version-agent-runtime"/);
    assert.match(workflow, /tags: \$\{\{ steps.agent-metadata.outputs.tags \}\}/);
    assert.match(workflow, /node-version-file: .node-version/);
    assert.ok(workflow.indexOf("node scripts/versions.mjs check") < workflow.indexOf("node --test"));
    assert.doesNotMatch(workflow, /0\.12\.0|unpublished-package|integration-package-ref|build-contexts/);
});

for (const name of ["keycloak-startup", "service-health", "ui-cors", "run-context"]) {
    test(`should confine the recovered ${name} adapter to the supported package version`, () => {
        const adapter = fs.readFileSync(path.join(root, `orchestrator/compatibility/patch-${name}.mjs`), "utf8");
        assert.match(adapter, /createRequire\(import.meta.url\)/);
        assert.match(adapter, /require.resolve\('@onecx\/integration-tests'\)/);
        assert.match(adapter, /import \{ assertSupportedIntegrationVersion \} from '\.\/supported-version.mjs'/);
        assert.match(adapter, /assertSupportedIntegrationVersion\(metadata.version\)/);
        assert.match(adapter, /Refusing to apply/);
    });
}
