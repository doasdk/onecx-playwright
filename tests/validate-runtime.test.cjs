const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, afterEach } = require("node:test");
const { validateRuntime } = require("../runtime/validate-runtime.cjs");

const directories = [];

function application(
  manifest = { scripts: { "tests:gui": "playwright test" } },
  version = "1.64.0",
) {
  const root = mkdtempSync(join(__dirname, ".onecx-runtime-test-"));
  directories.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  const packageRoot = join(root, "node_modules", "@playwright", "test");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version }));
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("should accept an app when its runner matches the image browsers", () => {
  assert.doesNotThrow(() =>
    validateRuntime(application(), "tests:gui", "1.64.0"),
  );
});

test("should reject a script when the scripts section is missing", () => {
  assert.throws(
    () => validateRuntime(application({}), "tests:gui", "1.64.0"),
    /must define npm script/,
  );
});

test("should reject a script when its name is missing", () => {
  assert.throws(
    () => validateRuntime(application(), "tests:unknown", "1.64.0"),
    /must define npm script/,
  );
});

test("should reject a script when its command is empty", () => {
  assert.throws(
    () =>
      validateRuntime(
        application({ scripts: { "tests:gui": "  " } }),
        "tests:gui",
        "1.64.0",
      ),
    /must define npm script/,
  );
});

test("should reject the app when its runner differs from the image browsers", () => {
  assert.throws(
    () =>
      validateRuntime(application(undefined, "1.65.0"), "tests:gui", "1.64.0"),
    /does not match/,
  );
});

test("should reject a script when its command is not a string", () => {
  assert.throws(
    () =>
      validateRuntime(
        application({ scripts: { "tests:gui": false } }),
        "tests:gui",
        "1.64.0",
      ),
    /must define npm script/,
  );
});

test("should fail explicitly when the app manifest is missing", () => {
  const root = application();
  rmSync(join(root, "package.json"));
  assert.throws(() => validateRuntime(root, "tests:gui", "1.64.0"), /ENOENT/);
});

test("should fail explicitly when the app runner is not installed", () => {
  const root = application();
  rmSync(join(root, "node_modules"), { recursive: true, force: true });
  assert.throws(
    () => validateRuntime(root, "tests:gui", "1.64.0"),
    /Cannot find module/,
  );
});

test("should accept the consumer when validation is invoked as a command", () => {
  const result = spawnSync(
    process.execPath,
    [join(__dirname, "../runtime/validate-runtime.cjs"), "tests:gui"],
    {
      cwd: application(),
      env: { ...process.env, ONECX_PLAYWRIGHT_VERSION: "1.64.0" },
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
});

test("should return a nonzero status when command validation fails", () => {
  const result = spawnSync(
    process.execPath,
    [join(__dirname, "../runtime/validate-runtime.cjs"), "tests:gui"],
    {
      cwd: application(undefined, "1.65.0"),
      env: { ...process.env, ONECX_PLAYWRIGHT_VERSION: "1.64.0" },
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match/);
});
