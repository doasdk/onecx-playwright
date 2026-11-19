import { chromium } from "@playwright/test";
import { join, resolve } from "node:path";
import { test as authenticatedTest } from "../e2e/fixtures/basePage";

export const runtimeDirectory =
  process.env.ONECX_AGENT_RUNTIME_DIR || "/opt/onecx-agent";
const runtime = require(join(runtimeDirectory, "playwright.cjs"));
export const configPath = resolve(__dirname, "agent.config.json");

// Keep the application's existing authenticatedPage implementation: it logs in and navigates.
export const test = authenticatedTest.extend<{
  liveBrowser: Awaited<ReturnType<typeof runtime.createLiveBrowser>>;
  agentEnvironment: NodeJS.ProcessEnv;
}>(
  runtime.createAgentFixtures({
    chromium,
    configPath,
    outputRoot: resolve(__dirname, "../results/agent-local"),
  }),
);

export { runtime };
