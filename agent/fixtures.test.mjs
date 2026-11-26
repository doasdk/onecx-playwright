import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const runtime = require("./playwright.cjs");

for (const fails of [false, true]) {
  test(`should keep the caller's authenticated page and close it when fixture usage ${fails ? "fails" : "completes"}`, async (t) => {
    const calls = [];
    const chromium = {};
    const live = {
      page: {},
      context: {},
      close: async () => calls.push("close"),
    };
    const previousInitialize = runtime.initializeAgentReport;
    const previousCreate = runtime.createLiveBrowser;
    runtime.initializeAgentReport = async (options) =>
      calls.push(["initialize", options]);
    runtime.createLiveBrowser = async (options) => {
      calls.push(["create", options]);
      return live;
    };
    t.after(() => {
      runtime.initializeAgentReport = previousInitialize;
      runtime.createLiveBrowser = previousCreate;
    });
    const fixtures = runtime.createAgentFixtures({
      chromium,
      configPath: "scenario.json",
      outputRoot: "results",
    });
    const env = { OUTPUT_DIR: "test-output" };
    const error = new Error("Synthetic fixture failure");
    const run = fixtures.liveBrowser(
      {
        contextOptions: { locale: "en" },
        ignoreHTTPSErrors: true,
        agentEnvironment: env,
      },
      async (actual) => {
        assert.equal(actual, live);
        calls.push("use");
        if (fails) throw error;
      },
    );
    if (fails) await assert.rejects(run, (actual) => actual === error);
    else await run;
    assert.deepEqual(calls, [
      ["initialize", { configPath: "scenario.json", env }],
      [
        "create",
        {
          chromium,
          contextOptions: { locale: "en", ignoreHTTPSErrors: true },
          env,
        },
      ],
      "use",
      "close",
    ]);
    await fixtures.context({ liveBrowser: live }, async (actual) =>
      assert.equal(actual, live.context),
    );
    await fixtures.page({ liveBrowser: live }, async (actual) =>
      assert.equal(actual, live.page),
    );
  });
}

for (const explicit of [undefined, "explicit-output"]) {
  test(`should select ${explicit || "consumer fallback"} when configuring agent output`, async (t) => {
    const previous = process.env.OUTPUT_DIR;
    if (explicit === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = explicit;
    t.after(() => {
      if (previous === undefined) delete process.env.OUTPUT_DIR;
      else process.env.OUTPUT_DIR = previous;
    });
    const fixtures = runtime.createAgentFixtures({
      chromium: {},
      configPath: "scenario.json",
      outputRoot: "consumer-output",
    });
    await fixtures.agentEnvironment({}, async (env) => {
      assert.equal(env.OUTPUT_DIR, explicit || "consumer-output");
      assert.equal(env.PATH, process.env.PATH);
    });
  });
}
