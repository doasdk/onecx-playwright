import { expect } from "@playwright/test";
import { test, runtime, configPath } from "./live.fixture";

test("observes the authenticated application", async ({
  authenticatedPage,
  liveBrowser,
  agentEnvironment,
}, testInfo) => {
  // Use the application's own readiness assertion here, without navigating to a fresh tab.
  await expect(authenticatedPage.locator("body")).toBeVisible();
  testInfo.annotations.push({ type: "agent-prepared" });
  await runtime.recordAssessment(authenticatedPage, testInfo, async () => {
    const result = await runtime.runBrowserAgent({
      page: authenticatedPage,
      cdpEndpoint: liveBrowser.cdpEndpoint,
      configPath,
      env: agentEnvironment,
      secrets: [process.env.APP_PASSWORD || ""],
    });
    expect(result).toBe(0);
  });
});
