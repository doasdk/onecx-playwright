function createAgentFixtures({ chromium, configPath, outputRoot }) {
  const runtime = require("./playwright.cjs");
  return {
    agentEnvironment: async ({}, use) => {
      await use({
        ...process.env,
        OUTPUT_DIR: process.env.OUTPUT_DIR || outputRoot,
      });
    },
    liveBrowser: async (
      { contextOptions, ignoreHTTPSErrors, agentEnvironment },
      use,
    ) => {
      await runtime.initializeAgentReport({
        configPath,
        env: agentEnvironment,
      });
      const live = await runtime.createLiveBrowser({
        chromium,
        contextOptions: { ...contextOptions, ignoreHTTPSErrors },
        env: agentEnvironment,
      });
      try {
        await use(live);
      } finally {
        await live.close();
      }
    },
    context: async ({ liveBrowser }, use) => {
      await use(liveBrowser.context);
    },
    page: async ({ liveBrowser }, use) => {
      await use(liveBrowser.page);
    },
  };
}

exports.createAgentFixtures = createAgentFixtures;
