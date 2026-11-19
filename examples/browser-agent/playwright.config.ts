import { defineConfig } from "@playwright/test";
import { join, resolve } from "node:path";
import scenario from "./agent.config.json";

const outputRoot = resolve(
  process.env.OUTPUT_DIR || resolve(__dirname, "../results/agent-local"),
);
const runtimeDirectory =
  process.env.ONECX_AGENT_RUNTIME_DIR || "/opt/onecx-agent";

export default defineConfig({
  testDir: __dirname,
  testMatch: "browser-agent.spec.ts",
  timeout: 1_020_000,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  outputDir: join(outputRoot, "test-results"),
  reporter: [
    ["line"],
    [
      join(runtimeDirectory, "allure-reporter.cjs"),
      {
        outputRoot,
        requiredChecks: scenario.requiredChecks,
        suite: "Application",
      },
    ],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    ignoreHTTPSErrors: !!process.env.TLS_CA_CERT_PATH,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
