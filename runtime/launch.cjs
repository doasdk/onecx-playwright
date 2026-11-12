const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { constants: osConstants } = require("node:os");
const { validateRuntime } = require("./validate-runtime.cjs");

class ConfigurationError extends Error {}

function check(condition, message) {
  if (!condition) throw new ConfigurationError(message);
}

function readableFile(file, message) {
  try {
    check(fs.statSync(file).isFile(), message);
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    throw new ConfigurationError(message);
  }
}

function prepareOutput(directory) {
  try {
    // Recursive mkdir can retry indefinitely on virtual filesystems returning ENOENT.
    const missing = [];
    let ancestor = directory;
    while (!fs.existsSync(ancestor)) {
      missing.push(ancestor);
      ancestor = path.dirname(ancestor);
    }
    for (const entry of missing.reverse()) {
      try {
        fs.mkdirSync(entry);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const probe = path.join(directory, `.onecx-write-${process.pid}`);
    const fd = fs.openSync(probe, "wx", 0o600);
    fs.closeSync(fd);
    fs.unlinkSync(probe);
  } catch {
    throw new ConfigurationError("Artifact output directory is not writable.");
  }
}

function safeEnvironmentName(name) {
  const upper = name.toUpperCase();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(NODE_|NPM_|ONECX_|PLAYWRIGHT_|LD_|DYLD_)/.test(upper) &&
    (!upper.startsWith("TEST_") || upper === "TEST_DATA_JSON") &&
    !new Set([
      "PATH", "PATHEXT", "HOME", "USERPROFILE", "SHELL", "COMSPEC",
      "BASH_ENV", "ENVIRONMENT", "BASHOPTS", "SHELLOPTS", "IFS",
      "PWD", "OLDPWD", "INIT_CWD", "TMP", "TEMP", "TMPDIR",
      "GCONV_PATH", "LOCPATH", "OPENSSL_CONF", "OPENSSL_MODULES", "SSLKEYLOGFILE",
      "CDPATH", "ZDOTDIR",
      "__PROTO__", "CONSTRUCTOR", "PROTOTYPE",
    ]).has(upper);
}

function readEnvelope(file) {
  readableFile(file, "Runtime envelope is not a readable file.");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ConfigurationError("Runtime envelope is not valid JSON.");
  }
  check(value && typeof value === "object" && !Array.isArray(value),
    "Runtime envelope must be an object.");
  check(Object.keys(value).every((key) =>
    ["version", "script", "config", "environment"].includes(key)),
  "Runtime envelope contains unsupported fields.");
  check(value.version === 1, "Runtime envelope version must be 1.");
  check(typeof value.script === "string" && value.script.trim() &&
    !value.script.startsWith("-"), "Runtime script must be a nonempty script name.");
  check(typeof value.config === "string" && value.config.trim(),
    "Runtime config must be a nonempty path.");
  check(value.environment && typeof value.environment === "object" &&
    !Array.isArray(value.environment), "Runtime environment must be an object.");
  for (const [name, setting] of Object.entries(value.environment)) {
    check(safeEnvironmentName(name), "Runtime environment contains a reserved or unsafe name.");
    check(typeof setting === "string" && !setting.includes("\0"),
      "Runtime environment values must be strings without NUL characters.");
  }
  return value;
}

function configuration(env, args, envelope) {
  let script = env.TEST_SCRIPT || args[0] || "tests:gui";
  let config = env.ONECX_PLAYWRIGHT_CONFIG;
  const forwarded = args.slice(args.length ? 1 : 0);
  if (envelope) {
    script = envelope.script;
    config = envelope.config;
  }
  check(typeof script === "string" && script.trim() && !script.startsWith("-"),
    "Runtime script must be a nonempty script name.");
  check(!forwarded.some((arg) => arg === "-c" || arg.startsWith("-c=") ||
    arg === "--config" || arg.startsWith("--config=")),
  "Select the config through the runtime contract, not forwarded arguments.");
  let root;
  try {
    root = fs.realpathSync(env.TEST_ROOT || "/app/integration");
    check(fs.statSync(root).isDirectory(), "Test root is not a readable directory.");
  } catch {
    throw new ConfigurationError("Test root is not a readable directory.");
  }
  if (!config) {
    config = ["playwright.config.ts", "playwright.config.js"].find((name) =>
      fs.existsSync(path.join(root, name)));
  }
  check(typeof config === "string" && config.trim(), "Playwright config is missing.");
  let configPath;
  try {
    configPath = fs.realpathSync(path.resolve(root, config));
  } catch {
    throw new ConfigurationError("Playwright config is not a readable file.");
  }
  const relative = path.relative(root, configPath);
  check(relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative), "Playwright config must stay inside the test root.");
  readableFile(configPath, "Playwright config is not a readable file.");
  try {
    validateRuntime(root, script, env.ONECX_PLAYWRIGHT_VERSION);
  } catch {
    throw new ConfigurationError("App manifest, npm script, or installed Playwright version is invalid.");
  }
  if (env.TLS_CA_CERT_PATH) {
    const ca = path.resolve(root, env.TLS_CA_CERT_PATH);
    readableFile(ca, "TLS CA certificate is not a readable file.");
    env.NODE_EXTRA_CA_CERTS = ca;
  }
  env.TEST_ROOT = root;
  env.OUTPUT_DIR = path.resolve(env.OUTPUT_DIR || "/e2e-results");
  return { root, script, configPath, forwarded };
}

async function launch({
  env = { ...process.env },
  args = process.argv.slice(2),
  spawnProcess = spawn,
  signalSource = process,
  killGroup = (pid, signal) => process.kill(-pid, signal),
  stderr = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  let output = path.resolve(env.OUTPUT_DIR || "/e2e-results");
  const record = (status, exitCode) => {
    try {
      prepareOutput(output);
      const target = path.join(output, "execution.json");
      const fd = fs.openSync(target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC |
        fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ version: 1, status, exitCode })}\n`);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      stderr("OneCX runtime: execution manifest could not be written.");
    }
    return exitCode;
  };
  let settings;
  try {
    try {
      prepareOutput(output);
    } catch (error) {
      if (!env.ONECX_RUNTIME_FILE) throw error;
    }
    let envelope;
    if (env.ONECX_RUNTIME_FILE) {
      envelope = readEnvelope(env.ONECX_RUNTIME_FILE);
      Object.assign(env, envelope.environment);
      output = path.resolve(env.OUTPUT_DIR || "/e2e-results");
      prepareOutput(output);
    }
    settings = configuration(env, args, envelope);
    output = env.OUTPUT_DIR;
    prepareOutput(output);
  } catch (error) {
    stderr(`OneCX runtime configuration error: ${error instanceof ConfigurationError ?
      error.message : "Invalid runtime configuration."}`);
    return record("configuration-failed", 2);
  }
  return new Promise((resolve) => {
    let child;
    let interrupted;
    let finished = false;
    const handlers = new Map();
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      for (const [name, handler] of handlers) signalSource.removeListener(name, handler);
      const termination = interrupted || signal;
      const exitCode = termination ?
        128 + (osConstants.signals[termination] || 1) : (code ?? 127);
      resolve(record(termination ? "interrupted" :
        exitCode === 0 ? "success" : "test-failed", exitCode));
    };
    try {
      child = spawnProcess("npm",
        ["run", settings.script, "--", "--config", settings.configPath, ...settings.forwarded],
        { cwd: settings.root, env, stdio: "inherit", detached: true });
    } catch {
      stderr("OneCX runtime: npm could not be started.");
      finish(127);
      return;
    }
    child.once("error", () => {
      stderr("OneCX runtime: npm could not be started.");
      finish(127);
    });
    child.once("close", finish);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        interrupted ||= signal;
        try {
          killGroup(child.pid, signal);
        } catch {
          try { child.kill(signal); } catch { /* Child may already have exited. */ }
        }
      };
      handlers.set(signal, handler);
      signalSource.on(signal, handler);
    }
  });
}

module.exports = { launch, configuration, readEnvelope, safeEnvironmentName, prepareOutput };

if (require.main === module) {
  launch().then((code) => { process.exitCode = code; });
}
