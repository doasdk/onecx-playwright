const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync, spawn } = require("node:child_process");
const { test, afterEach } = require("node:test");
const { launch, configuration, readEnvelope, safeEnvironmentName, prepareOutput } = require("../runtime/launch.cjs");

const directories = [];
function app() {
  const root = fs.mkdtempSync(path.join(__dirname, ".launch-test-"));
  directories.push(root);
  const runner = path.join(root, "node_modules", "@playwright", "test");
  fs.mkdirSync(runner, { recursive: true });
  fs.writeFileSync(path.join(runner, "package.json"), '{"version":"1.64.0"}');
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"tests:gui":"playwright test"}}');
  fs.writeFileSync(path.join(root, "playwright.config.js"), "module.exports = {}");
  return {
    root,
    env: { TEST_ROOT: root, OUTPUT_DIR: path.join(root, "results"),
      ONECX_PLAYWRIGHT_VERSION: "1.64.0" },
  };
}
function envelope(application, overrides = {}) {
  const file = path.join(application.root, "runtime.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1, script: "tests:gui", config: "playwright.config.js", environment: {},
    ...overrides,
  }));
  application.env.ONECX_RUNTIME_FILE = file;
  return file;
}
async function run(application, options = {}) {
  const errors = [];
  const signals = new EventEmitter();
  let spawned;
  const code = await launch({
    env: application.env, args: ["tests:gui"], signalSource: signals,
    stderr: (message) => errors.push(message),
    spawnProcess: (command, args, settings) => {
      spawned = { command, args, settings };
      const child = new EventEmitter();
      child.pid = 123;
      child.kill = () => {};
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    },
    ...options,
  });
  let manifest;
  const target = path.join(application.env.OUTPUT_DIR, "execution.json");
  if (fs.existsSync(target)) manifest = JSON.parse(fs.readFileSync(target));
  return { code, manifest, errors, spawned, signals };
}
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Image defaults such as /e2e-results are absolute and may be unavailable or
// unwritable on the host, so redirect them to a temporary directory.
async function withImagePath(imagePath, hostPath, action) {
  const image = path.resolve(imagePath);
  const map = (value) => {
    if (typeof value !== "string") return value;
    const resolved = path.resolve(value);
    if (resolved === image) return hostPath;
    return resolved.startsWith(image + path.sep) ?
      path.join(hostPath, resolved.slice(image.length + 1)) : value;
  };
  const names = ["realpathSync", "statSync", "existsSync", "mkdirSync",
    "openSync", "unlinkSync", "accessSync"];
  const originals = names.map((name) => fs[name]);
  names.forEach((name, index) => {
    fs[name] = (value, ...rest) => originals[index](map(value), ...rest);
  });
  try {
    return await action();
  } finally {
    names.forEach((name, index) => { fs[name] = originals[index]; });
  }
}

test("should launch the standalone script with detected JS config and unchanged arguments", async () => {
  const application = app();
  const result = await run(application, { args: ["ignored", "--project=chromium"],
    env: { ...application.env, TEST_SCRIPT: "tests:gui" } });
  assert.equal(result.code, 0);
  assert.deepEqual(result.spawned.args, ["run", "tests:gui", "--", "--config",
    path.join(application.root, "playwright.config.js"), "--project=chromium"]);
  assert.deepEqual(result.manifest, { version: 1, status: "success", exitCode: 0 });
});

test("should apply the envelope and CA before npm starts", async () => {
  const application = app();
  const ca = path.join(application.root, "ca.pem");
  fs.writeFileSync(ca, "readable certificate");
  const environment = {
    CI: "true", ENV: "container", ENVIRONMENTS_JSON: '{"password":"secret"}',
    TEST_DATA_JSON: "{}", BASE_URL: "https://example.test", PLATFORM_INFO_JSON: "{}",
    CAPTURE_PRIVATE_ARTIFACTS: "false", TLS_CA_CERT_PATH: ca,
    OUTPUT_DIR: path.join(application.root, "custom-results"),
  };
  envelope(application, { environment });
  const result = await run(application, { args: ["ignored"] });
  assert.equal(result.spawned.settings.env.NODE_EXTRA_CA_CERTS, ca);
  for (const [key, value] of Object.entries(environment))
    assert.equal(result.spawned.settings.env[key], value);
  assert.deepEqual(result.manifest, { version: 1, status: "success", exitCode: 0 });
});

for (const name of [
  "TEST_ROOT", "ONECX_PLAYWRIGHT_VERSION", "ONECX_RUNTIME_FILE", "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS", "PATH", "npm_config_prefix", "LD_PRELOAD", "BASH_ENV",
  "PLAYWRIGHT_BROWSERS_PATH", "__proto__", "TEST_SCRIPT", "HOME", "bad-name",
]) {
  test(`should reject reserved envelope setting ${name}`, async () => {
    const application = app();
    envelope(application, { environment: { [name]: "secret" } });
    const result = await run(application);
    assert.equal(result.code, 2);
    assert.equal(result.manifest.status, "configuration-failed");
    assert.equal(result.spawned, undefined);
    assert.ok(!result.errors.join("").includes("secret"));
  });
}

for (const overrides of [
  { version: 2 }, { script: "" }, { script: "-x" }, { config: "" },
  { environment: null }, { environment: [] }, { environment: { CI: true } },
  { environment: { CI: "x\0y" } }, { password: "secret" },
]) {
  test(`should reject invalid envelope shape ${JSON.stringify(overrides)}`, async () => {
    const application = app();
    envelope(application, overrides);
    const result = await run(application);
    assert.equal(result.manifest.status, "configuration-failed");
    assert.equal(result.code, 2);
  });
}

test("should redact malformed JSON instead of printing input snippets", async () => {
  const application = app();
  const file = envelope(application);
  fs.writeFileSync(file, '{"password":"top-secret"');
  const result = await run(application);
  assert.equal(result.code, 2);
  assert.ok(!result.errors.join("").includes("top-secret"));
});

test("should reject an unreadable runtime envelope", async () => {
  const application = app();
  application.env.ONECX_RUNTIME_FILE = path.join(application.root, "missing");
  assert.equal((await run(application)).code, 2);
});

test("should reject a non-object runtime envelope", () => {
  const application = app();
  const file = envelope(application);
  fs.writeFileSync(file, "null");
  assert.throws(() => readEnvelope(file), /must be an object/);
});

for (const scenario of ["missing-root", "missing-config", "missing-runner", "version",
  "script", "ca", "directory-config", "config-argument", "invalid-manifest"]) {
  test(`should export configuration failure for ${scenario}`, async () => {
    const application = app();
    let args = ["tests:gui"];
    if (scenario === "missing-root") application.env.TEST_ROOT += "-missing";
    if (scenario === "missing-config") fs.unlinkSync(path.join(application.root, "playwright.config.js"));
    if (scenario === "missing-runner") fs.rmSync(path.join(application.root, "node_modules"), { recursive: true });
    if (scenario === "version") application.env.ONECX_PLAYWRIGHT_VERSION = "0.0.0";
    if (scenario === "script") args = ["unknown"];
    if (scenario === "ca") application.env.TLS_CA_CERT_PATH = "missing.pem";
    if (scenario === "directory-config") application.env.ONECX_PLAYWRIGHT_CONFIG = application.root;
    if (scenario === "config-argument") args.push("--config=outside");
    if (scenario === "invalid-manifest") fs.writeFileSync(path.join(application.root, "package.json"), "secret");
    const result = await run(application, { args });
    assert.deepEqual(result.manifest, { version: 1, status: "configuration-failed", exitCode: 2 });
    assert.equal(result.spawned, undefined);
  });
}

test("should keep config inside the real test root including symlink resolution", async () => {
  const application = app();
  const outside = app();
  const link = path.join(application.root, "linked.js");
  fs.symlinkSync(path.join(outside.root, "playwright.config.js"), link);
  envelope(application, { config: link });
  assert.equal((await run(application)).code, 2);
});

test("should reject relative config traversal outside the test root", async () => {
  const application = app();
  const outside = app();
  envelope(application, { config: path.relative(application.root, path.join(outside.root, "playwright.config.js")) });
  assert.equal((await run(application)).code, 2);
});

test("should select the TS default before JS", async () => {
  const application = app();
  fs.writeFileSync(path.join(application.root, "playwright.config.ts"), "export default {}");
  const result = await run(application, { args: [] });
  assert.equal(result.spawned.args[4], path.join(application.root, "playwright.config.ts"));
});

test("should export errors into envelope OUTPUT_DIR before validating the app", async () => {
  const application = app();
  envelope(application, { script: "missing", environment: {
    OUTPUT_DIR: path.join(application.root, "custom"),
  } });
  assert.equal((await run(application)).manifest.status, "configuration-failed");
});

test("should fail explicitly when artifact output cannot be created", async () => {
  const application = app();
  application.env.OUTPUT_DIR = path.join(application.root, "package.json");
  const result = await run(application);
  assert.equal(result.code, 2);
  assert.match(result.errors.join(" "), /not writable/);
});

for (const code of [1, 7, 127]) {
  test(`should classify npm exit ${code} as test-failed and preserve its exit code`, async () => {
    const result = await run(app(), { spawnProcess: () => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", code, null));
      return child;
    } });
    assert.deepEqual(result.manifest, { version: 1, status: "test-failed", exitCode: code });
    assert.equal(result.code, code);
  });
}

for (const mode of ["throw", "error"]) {
  test(`should classify npm spawn ${mode} as test-failed without leaking errors`, async () => {
    const result = await run(app(), { spawnProcess: () => {
      if (mode === "throw") throw new Error("secret");
      const child = new EventEmitter();
      process.nextTick(() => {
        child.emit("error", new Error("secret"));
        child.emit("close", -2, null);
      });
      return child;
    } });
    assert.equal(result.manifest.status, "test-failed");
    assert.equal(result.code, 127);
    assert.ok(!result.errors.join("").includes("secret"));
  });
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  test(`should forward ${signal} to the npm process group and export interruption`, async () => {
    const signals = new EventEmitter();
    const calls = [];
    const result = await run(app(), {
      signalSource: signals, killGroup: (...args) => calls.push(args),
      spawnProcess: () => {
        const child = new EventEmitter();
        child.pid = 321;
        process.nextTick(() => {
          signals.emit(signal);
          child.emit("close", 0, null);
        });
        return child;
      },
    });
    assert.deepEqual(calls, [[321, signal]]);
    assert.deepEqual(result.manifest, { version: 1, status: "interrupted", exitCode: code });
    assert.equal(signals.listenerCount(signal), 0);
  });
}

test("should classify npm self-termination as interrupted", async () => {
  const result = await run(app(), { spawnProcess: () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", null, "SIGTERM"));
    return child;
  } });
  assert.equal(result.manifest.status, "interrupted");
  assert.equal(result.code, 143);
});

test("should allow generic application environment settings", () => {
  assert.equal(safeEnvironmentName("CUSTOM_APPLICATION_SETTING"), true);
});

test("should reject an explicit missing config", async () => {
  const application = app();
  application.env.ONECX_PLAYWRIGHT_CONFIG = "missing.js";
  assert.equal((await run(application)).code, 2);
});

test("should reject a file used as the test root", async () => {
  const application = app();
  application.env.TEST_ROOT = path.join(application.root, "package.json");
  assert.equal((await run(application)).code, 2);
});

test("should use inherited config selection when supplied", async () => {
  const application = app();
  application.env.ONECX_PLAYWRIGHT_CONFIG = path.join(application.root, "playwright.config.js");
  assert.equal((await run(application)).code, 0);
});

test("should reject an invalid standalone script type", async () => {
  const application = app();
  application.env.TEST_SCRIPT = 123;
  assert.equal((await run(application)).code, 2);
});

test("should preserve interruption when process-group forwarding needs child fallback", async () => {
  const signals = new EventEmitter();
  let forwarded;
  const result = await run(app(), {
    signalSource: signals,
    killGroup: () => { throw new Error("gone"); },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.kill = (signal) => { forwarded = signal; };
      process.nextTick(() => {
        signals.emit("SIGINT");
        child.emit("close", null, "SIGINT");
      });
      return child;
    },
  });
  assert.equal(forwarded, "SIGINT");
  assert.equal(result.code, 130);
});

test("should finish interruption when both forwarding attempts find an exited child", async () => {
  const signals = new EventEmitter();
  const result = await run(app(), {
    signalSource: signals,
    killGroup: () => { throw new Error("gone"); },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.kill = () => { throw new Error("gone"); };
      process.nextTick(() => {
        signals.emit("SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return child;
    },
  });
  assert.equal(result.code, 143);
});

test("should classify a missing npm exit code as test-failed", async () => {
  const result = await run(app(), { spawnProcess: () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", null, null));
    return child;
  } });
  assert.equal(result.code, 127);
});

test("should classify an unknown termination signal with a nonzero interrupted exit", async () => {
  const result = await run(app(), { spawnProcess: () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", null, "UNKNOWN"));
    return child;
  } });
  assert.equal(result.code, 129);
});

test("should redact unexpected IO errors during configuration", async () => {
  const application = app();
  const original = fs.existsSync;
  fs.existsSync = () => {
    fs.existsSync = original;
    throw new Error("secret");
  };
  let result;
  try {
    result = await run(application);
  } finally {
    fs.existsSync = original;
  }
  assert.equal(result.code, 2);
  assert.ok(!result.errors.join("").includes("secret"));
});

test("should execute the CLI with its default npm implementation", () => {
  const application = app();
  fs.writeFileSync(path.join(application.root, "package.json"),
    '{"scripts":{"tests:gui":"node finish.cjs"}}');
  fs.writeFileSync(path.join(application.root, "finish.cjs"), "process.exit(0)");
  const result = spawnSync(process.execPath, [path.join(__dirname, "../runtime/launch.cjs")],
    { env: { ...process.env, ...application.env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("should print a redacted CLI configuration diagnostic to stderr", () => {
  const application = app();
  application.env.TEST_ROOT = path.join(application.root, "missing-secret");
  const result = spawnSync(process.execPath, [path.join(__dirname, "../runtime/launch.cjs")],
    { env: { ...process.env, ...application.env }, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /configuration error/);
  assert.ok(!result.stderr.includes("secret"));
});

test("should forward a real signal to the spawned npm process group", async () => {
  const application = app();
  fs.writeFileSync(path.join(application.root, "package.json"),
    '{"scripts":{"tests:gui":"node wait.cjs"}}');
  fs.writeFileSync(path.join(application.root, "wait.cjs"),
    'console.log("ready"); setInterval(() => {}, 1000)');
  const child = spawn(process.execPath, [path.join(__dirname, "../runtime/launch.cjs")],
    { env: { ...process.env, ...application.env }, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

  let sent = false;
  child.stdout.on("data", (chunk) => {
    if (!sent && chunk.toString().includes("ready")) {
      sent = true;
      child.kill("SIGTERM");
    }
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    assert.equal(await exit, 143);
  } finally {
    clearTimeout(timeout);
  }
});

test("should use the image test root when TEST_ROOT is absent", async () => {
  const emptyRoot = fs.mkdtempSync(path.join(__dirname, ".launch-test-"));
  directories.push(emptyRoot);
  await withImagePath("/app/integration", emptyRoot, () => {
    assert.throws(() => configuration({ OUTPUT_DIR: "/e2e-results" }, []),
      /Playwright config is missing/);
  });
});

test("should use the image artifact directory when OUTPUT_DIR is absent", async () => {
  const application = app();
  delete application.env.OUTPUT_DIR;
  const child = new EventEmitter();
  const code = await withImagePath("/e2e-results", path.join(application.root, "results"),
    () => launch({
      env: application.env, args: [],
      spawnProcess: () => {
        process.nextTick(() => child.emit("close", 0, null));
        return child;
      },
    }));
  assert.equal(code, 0);
  assert.equal(application.env.OUTPUT_DIR, path.resolve("/e2e-results"));
});

test("should use the image artifact directory for an envelope without an output setting", async () => {
  const application = app();
  delete application.env.OUTPUT_DIR;
  envelope(application);
  const child = new EventEmitter();
  const code = await withImagePath("/e2e-results", path.join(application.root, "results"),
    () => launch({
      env: application.env, args: [],
      spawnProcess: () => {
        process.nextTick(() => child.emit("close", 0, null));
        return child;
      },
    }));
  assert.equal(code, 0);
  assert.equal(application.env.OUTPUT_DIR, path.resolve("/e2e-results"));
});

test("should accept a writable envelope output when the inherited output is unusable", async () => {
  const application = app();
  application.env.OUTPUT_DIR = path.join(application.root, "package.json");
  envelope(application, { environment: { OUTPUT_DIR: path.join(application.root, "custom") } });
  assert.equal((await run(application)).code, 0);
});

test("should create nested artifact directories without recursive mkdir", () => {
  const application = app();
  const output = path.join(application.root, "nested", "results");
  prepareOutput(output);
  assert.ok(fs.statSync(output).isDirectory());
});

test("should accept an artifact directory created concurrently", () => {
  const application = app();
  const output = path.join(application.root, "race");
  const original = fs.mkdirSync;
  fs.mkdirSync = (directory) => {
    original(directory);
    const error = new Error("existing");
    error.code = "EEXIST";
    throw error;
  };
  try {
    assert.doesNotThrow(() => prepareOutput(output));
  } finally {
    fs.mkdirSync = original;
  }
});

test("should fail output preparation instead of retrying filesystem ENOENT", () => {
  const application = app();
  const original = fs.mkdirSync;
  fs.mkdirSync = () => {
    const error = new Error("virtual filesystem");
    error.code = "ENOENT";
    throw error;
  };
  try {
    assert.throws(() => prepareOutput(path.join(application.root, "missing")), /not writable/);
  } finally {
    fs.mkdirSync = original;
  }
});
