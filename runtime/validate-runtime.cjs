const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");

function validateRuntime(root, script, expectedVersion) {
  const manifestPath = resolve(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest.scripts?.[script] !== "string" ||
    !manifest.scripts[script].trim()
  ) {
    throw new Error(
      `Automation package ${manifestPath} must define npm script "${script}".`,
    );
  }
  const requireFromApp = createRequire(manifestPath);
  const { version } = requireFromApp("@playwright/test/package.json");
  if (version !== expectedVersion) {
    throw new Error(
      `Application @playwright/test ${version} does not match image browsers ${expectedVersion}. ` +
        "Pin the application dependency and runtime image to compatible versions.",
    );
  }
}

module.exports = { validateRuntime };

if (require.main === module) {
  validateRuntime(
    process.cwd(),
    process.argv[2],
    process.env.ONECX_PLAYWRIGHT_VERSION,
  );
}
