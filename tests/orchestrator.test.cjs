const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, afterEach } = require("node:test");

const directories = [];
const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\sh.exe" : "sh";
const launcher = path.resolve(__dirname, "../orchestrator/workflow-launch.sh").replaceAll("\\", "/");

afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function run(mode, overrides = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, ".orchestrator-test-"));
  directories.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, "config.json"), "{}");
  if (overrides.DOCKER_CONFIG === "fixture") {
    overrides = { ...overrides, DOCKER_CONFIG: path.join(root, ".docker").replaceAll("\\", "/") };
    fs.mkdirSync(overrides.DOCKER_CONFIG);
    fs.writeFileSync(path.join(overrides.DOCKER_CONFIG, "config.json"), '{"auths":{"registry":{"auth":"private-auth"}}}');
  }
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$1 $2" in
  "volume create") echo test-volume ;;
  "volume inspect") echo "\${MOCK_MOUNTPOINT:-/var/lib/docker/volumes/test-volume/_data}" ;;
  "create "*) echo test-container ;;
  "start -a")
    echo '{"include":[{"runId":"smoke","selectionBase64":"e30="}]}'
    exit "\${MOCK_START_CODE:-0}" ;;
  "inspect "*) echo "\${MOCK_EXIT_CODE:-0}" ;;
  "stop "*) exit "\${MOCK_STOP_CODE:-0}" ;;
  "rm -f") exit "\${MOCK_REMOVE_CODE:-0}" ;;
  "volume rm") exit "\${MOCK_VOLUME_REMOVE_CODE:-0}" ;;
  "cp -") cat >/dev/null ;;
  "cp test-container:"*) exit "\${MOCK_EXPORT_CODE:-0}" ;;
esac
`, { mode: 0o755 });
  const shellBin = bin.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const result = spawnSync(shell, ["-c", 'export PATH="$MOCK_BIN:/usr/bin:/bin:$PATH"; exec sh "$@"', "sh", launcher, mode], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MOCK_BIN: shellBin,
      MSYS_NO_PATHCONV: "1",
      MOCK_LOG: path.join(root, "calls").replaceAll("\\", "/"),
      ORCHESTRATOR_IMAGE: "example/orchestrator@sha256:pinned",
      CONFIG_PATH: "config.json",
      MATRIX_SELECTION_BASE64: "e30=",
      RUN_ID: "smoke-run",
      DOCKER_CONFIG: "",
      ...overrides,
    },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const log = fs.existsSync(path.join(root, "calls")) ? fs.readFileSync(path.join(root, "calls"), "utf8") : "";
  return { ...result, root, log };
}

test("should use daemon-visible paths and the socket when running a selection", () => {
  const result = run("run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /src=test-volume,dst=\/var\/lib\/docker\/volumes\/test-volume\/_data/);
  assert.match(result.log, /src=\/var\/run\/docker.sock,dst=\/var\/run\/docker.sock/);
  assert.match(result.log, /--network host/);
  assert.match(result.log, /-e RUN_ID=smoke-run/);
  assert.match(result.log, /-e TMPDIR=\/var\/lib\/docker\/volumes\/test-volume\/_data\/work/);
  assert.match(result.log, /run --config .*\/source\/config.json --results .*\/results --work .*\/work --selection e30=/);
});

test("should override the image CI default for local execution", () => {
  const result = run("run", { CI: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /-e CI= /);
});

test("should preserve CI mode for pipeline execution", () => {
  const result = run("run", { CI: "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /-e CI=true /);
});

for (const mode of ["matrix", "report"]) {
  test(`should avoid the Docker socket when executing ${mode}`, () => {
    const result = run(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.log, /docker.sock/);
    assert.doesNotMatch(result.log, /--network host/);
  });
}

test("should persist matrix JSON without forwarding it to the host log", () => {
  const result = run("matrix");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Preparing integration matrix/);
  assert.match(result.stderr, /Staging configuration and source/);
  assert.match(result.stderr, /Executing integration matrix/);
  const matrix = JSON.parse(fs.readFileSync(path.join(result.root, ".onecx-ci/matrix.json")));
  assert.equal(matrix.include[0].runId, "smoke");
});

test("should copy opaque secret files without placing values in Docker arguments", () => {
  const result = run("run", { ENVIRONMENTS_JSON: '{"opaque":"private-environment"}', TEST_DATA_JSON: '{"opaque":"private-data"}' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /ENVIRONMENTS_JSON_FILE=/);
  assert.match(result.log, /TEST_DATA_JSON_FILE=/);
  assert.doesNotMatch(result.log + result.stdout + result.stderr, /private-environment|private-data/);
  const states = fs.readdirSync(path.join(result.root, ".onecx-ci")).filter((name) => name.startsWith("launch."));
  for (const state of states) {
    assert.equal(fs.existsSync(path.join(result.root, ".onecx-ci", state, "environments.json")), false);
    assert.equal(fs.existsSync(path.join(result.root, ".onecx-ci", state, "data.json")), false);
  }
});

test("should export results and clean containers and volumes when execution fails", () => {
  const result = run("run", { MOCK_START_CODE: "7" });
  assert.equal(result.status, 7);
  assert.match(result.log, /cp test-container:.*\/results\/\./);
  assert.match(result.log, /stop --time 30 test-container/);
  assert.match(result.log, /rm -f test-container/);
  assert.match(result.log, /volume rm -f test-volume/);
  assert.doesNotMatch(result.stdout, /include/);
});

test("should reject a failed container when Docker start returns success", () => {
  const result = run("run", { MOCK_EXIT_CODE: "7" });
  assert.notEqual(result.status, 0);
});

test("should reject paths outside the checkout before creating a volume", () => {
  const result = run("matrix", { CONFIG_PATH: "../secret.json" });
  assert.equal(result.status, 2);
  assert.equal(result.log, "");
});

test("should reject an unknown mode before creating a volume", () => {
  const result = run("unknown");
  assert.equal(result.status, 2);
  assert.equal(result.log, "");
});

test("should require a selection when starting a matrix run", () => {
  const result = run("run", { MATRIX_SELECTION_BASE64: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /volume rm -f test-volume/);
});

test("should copy explicit Docker authentication without exposing its contents", () => {
  const result = run("run", { DOCKER_CONFIG: "fixture" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /DOCKER_CONFIG=.*\/secrets\/docker/);
  assert.match(result.log, /cp .*\.docker\/\. test-container:.*\/secrets\/docker/);
  assert.doesNotMatch(result.log + result.stdout + result.stderr, /private-auth/);
});

test("should permit public registries when no Docker auth config exists", () => {
  const result = run("matrix", { DOCKER_CONFIG: "/missing-docker-config" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.log, /-e DOCKER_CONFIG=/);
});

test("should forward an explicit E2E image override", () => {
  const result = run("run", { E2E_IMAGE: "example/e2e@sha256:pinned" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /-e E2E_IMAGE=example\/e2e@sha256:pinned/);
});

test("should copy downloaded run artifacts when generating the combined report", () => {
  const result = run("report");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /cp .*\/results\/\. test-container:.*\/results/);
});

test("should reject a non-Linux Docker daemon and remove its allocated volume", () => {
  const result = run("matrix", { MOCK_MOUNTPOINT: "C:\\docker\\volume" });
  assert.equal(result.status, 2);
  assert.match(result.log, /volume rm -f test-volume/);
  assert.doesNotMatch(result.log, /create --init/);
});

test("should require an explicit orchestrator image before calling Docker", () => {
  const result = run("matrix", { ORCHESTRATOR_IMAGE: "" });
  assert.notEqual(result.status, 0);
  assert.equal(result.log, "");
});

test("should report failure and clean up when exporting results fails", () => {
  const result = run("run", { MOCK_EXPORT_CODE: "9" });
  assert.equal(result.status, 1);
  assert.match(result.log, /rm -f test-container/);
  assert.match(result.log, /volume rm -f test-volume/);
});

test("should require the indexed run identifier when starting a selected job", () => {
  const result = run("run", { RUN_ID: "" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.log, /create --init/);
  assert.match(result.log, /volume rm -f test-volume/);
});

for (const setting of ["MOCK_STOP_CODE", "MOCK_REMOVE_CODE", "MOCK_VOLUME_REMOVE_CODE"]) {
  test(`should diagnose cleanup failure when ${setting} is nonzero`, () => {
    const result = run("run", { [setting]: "9" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cleanup failed:/);
  });
  test(`should preserve execution failure when ${setting} also fails`, () => {
    const result = run("run", { MOCK_START_CODE: "7", [setting]: "9" });
    assert.equal(result.status, 7);
    assert.match(result.stderr, /Cleanup failed:/);
  });
}

for (const config of ["/outside.json", "folder/../../outside.json", "folder/..", ".."]) {
  test(`should reject escaping config path ${config}`, () => {
    const result = run("matrix", { CONFIG_PATH: config });
    assert.equal(result.status, 2);
    assert.equal(result.log, "");
  });
}
