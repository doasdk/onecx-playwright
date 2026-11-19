import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import AgentAllureReporter from "./allure-reporter.cjs";

const checks = ["title", "heading"];
const report = (verdicts = ["passed", "passed"]) => ({
  schemaVersion: 1,
  verdict: verdicts.includes("failed")
    ? "failed"
    : verdicts.includes("inconclusive")
      ? "inconclusive"
      : "passed",
  summary: "Safe assessment summary.",
  checks: verdicts.map((verdict, index) => ({
    name: checks[index],
    verdict,
    evidence: "Safe observed evidence.",
  })),
});

async function setup(t) {
  const outputRoot = await mkdtemp(join(tmpdir(), "onecx-agent-allure-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  return {
    outputRoot,
    reporter: new AgentAllureReporter({ outputRoot, requiredChecks: checks }),
    save: (value) =>
      writeFile(join(outputRoot, "agent-report.json"), JSON.stringify(value)),
  };
}

for (const [verdicts, runnerStatus, prepared, expected] of [
  [["passed", "passed"], "passed", true, "passed"],
  [["failed", "passed"], "failed", true, "failed"],
  [["failed", "passed"], "passed", true, "failed"],
  [["inconclusive", "passed"], "failed", true, "broken"],
  [["inconclusive", "passed"], "passed", true, "broken"],
  [["passed", "passed"], "failed", true, "broken"],
  [["passed", "passed"], "passed", false, "broken"],
  [["inconclusive", "inconclusive"], "failed", false, "broken"],
]) {
  test(`should publish ${expected} when checks are ${verdicts.join("/")} and runner is ${runnerStatus} with preparation ${prepared}`, async (t) => {
    const { outputRoot, reporter, save } = await setup(t);
    const videoPath = join(outputRoot, "assessment.webm");
    await writeFile(videoPath, "synthetic-video");
    const assessment = report(verdicts);
    await save({ ...assessment, privateField: "must-not-be-exported" });
    reporter.onTestEnd(
      {
        id: "fixed-agent-test",
        title: "Prepared page assessment",
        annotations: prepared ? [{ type: "agent-prepared" }] : [],
      },
      {
        status: runnerStatus,
        startTime: new Date(1000),
        duration: 250,
        errors: [{ message: "private-error" }],
        attachments: [
          {
            name: "Agent assessment video",
            contentType: "video/webm",
            path: videoPath,
          },
          {
            name: "Agent failure screenshot",
            contentType: "image/png",
            body: Buffer.from("synthetic-png"),
          },
          {
            name: "private attachment",
            contentType: "text/plain",
            body: Buffer.from("private-data"),
          },
          {
            name: "Agent assessment video",
            contentType: "text/plain",
            body: Buffer.from("not-video"),
          },
          {
            name: "Agent failure screenshot",
            contentType: "text/plain",
            body: Buffer.from("not-png"),
          },
        ],
      },
    );
    assert.deepEqual(
      reporter.onEnd(),
      expected === "passed" ? undefined : { status: "failed" },
    );
    const directory = join(outputRoot, "allure-results");
    const files = await readdir(directory);
    const result = JSON.parse(
      await readFile(
        join(
          directory,
          files.find((name) => name.endsWith("-result.json")),
        ),
        "utf8",
      ),
    );
    assert.equal(result.status, expected);
    assert.equal(result.name, "Prepared page assessment");
    assert.equal(result.historyId, "fixed-agent-test");
    assert.ok(!JSON.stringify(result).includes("Workspace"));
    assert.equal(result.stop - result.start, 250);
    assert.equal(result.steps[0].status, prepared ? "passed" : "broken");
    assert.deepEqual(
      result.steps.slice(1).map((step) => step.status),
      verdicts.map((verdict) =>
        verdict === "inconclusive" ? "broken" : verdict,
      ),
    );
    assert.equal(result.description, assessment.summary);
    assert.equal(
      result.steps[1].statusDetails.message,
      assessment.checks[0].evidence,
    );
    const attachment = await readFile(
      join(directory, result.attachments[0].source),
      "utf8",
    );
    assert.deepEqual(JSON.parse(attachment), assessment);
    assert.ok(!JSON.stringify(result).includes("private-error"));
    assert.ok(!attachment.includes("must-not-be-exported"));
    assert.deepEqual(
      result.attachments.map(({ name }) => name),
      expected === "passed"
        ? ["Sanitized agent assessment", "Agent assessment video"]
        : [
            "Sanitized agent assessment",
            "Agent assessment video",
            "Agent failure screenshot",
          ],
    );
    assert.equal(
      await readFile(join(directory, result.attachments[1].source), "utf8"),
      "synthetic-video",
    );
  });
}

test("should use the caller suite when configuring report labels", async (t) => {
  const { outputRoot, save } = await setup(t);
  await save(report());
  const reporter = new AgentAllureReporter({
    outputRoot,
    requiredChecks: checks,
    suite: "Products",
  });
  reporter.onTestEnd(
    {
      id: "products-assessment",
      title: "Products clarity",
      annotations: [{ type: "agent-prepared" }],
    },
    { status: "passed", startTime: new Date(), duration: 100, attachments: [] },
  );
  const directory = join(outputRoot, "allure-results");
  const file = (await readdir(directory)).find((name) =>
    name.endsWith("-result.json"),
  );
  const result = JSON.parse(await readFile(join(directory, file), "utf8"));
  assert.ok(
    result.labels.some(
      ({ name, value }) => name === "suite" && value === "Products",
    ),
  );
});

test("should generate Allure results when the real Playwright runner executes assessments", async (t) => {
  const directory = await mkdtemp(
    fileURLToPath(new URL("./.test-allure-", import.meta.url)),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputRoot = join(directory, "output");
  const reporterPath = fileURLToPath(
    new URL("./allure-reporter.cjs", import.meta.url),
  );
  const cli = fileURLToPath(
    new URL("./node_modules/playwright/cli.js", import.meta.url),
  );
  const config = join(directory, "playwright.config.cjs");
  await writeFile(
    config,
    `module.exports = {
    testDir: ${JSON.stringify(directory)}, testMatch: 'assessment.spec.cjs', workers: 1,
    outputDir: ${JSON.stringify(join(directory, "test-results"))},
    reporter: [[${JSON.stringify(reporterPath)}, {
      outputRoot: ${JSON.stringify(outputRoot)}, requiredChecks: ['title', 'heading']
    }]]
  }`,
  );
  await writeFile(
    join(directory, "assessment.spec.cjs"),
    `
    const { test } = require('playwright/test')
    const { mkdirSync, writeFileSync } = require('node:fs')
    const root = ${JSON.stringify(outputRoot)}
    for (const verdict of ['passed', 'failed', 'inconclusive']) {
      test('assessment ' + verdict, async ({}, info) => {
        mkdirSync(root, { recursive: true })
        info.annotations.push({ type: 'agent-prepared' })
        writeFileSync(require('node:path').join(root, 'agent-report.json'), JSON.stringify({
          schemaVersion: 1, verdict, summary: 'Synthetic assessment',
          checks: ['title', 'heading'].map(name => ({ name, verdict, evidence: 'Synthetic observation' }))
        }))
      })
    }
  `,
  );
  for (const verdict of ["passed", "failed", "inconclusive"]) {
    const child = spawnSync(
      process.execPath,
      [cli, "test", "--config", config, "--grep", `assessment ${verdict}$`],
      {
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(
      child.status,
      verdict === "passed" ? 0 : 1,
      child.stdout + child.stderr,
    );
  }
  const results = await readdir(join(outputRoot, "allure-results"));
  const generated = await Promise.all(
    results
      .filter((file) => file.endsWith("-result.json"))
      .map(async (file) =>
        JSON.parse(
          await readFile(join(outputRoot, "allure-results", file), "utf8"),
        ),
      ),
  );
  assert.deepEqual(
    generated.map((result) => result.status).sort(),
    ["broken", "failed", "passed"],
    JSON.stringify(generated),
  );
});

const invalidReports = [
  null,
  { ...report(), schemaVersion: 2 },
  { ...report(), verdict: "unknown" },
  { ...report(), summary: "" },
  { ...report(), summary: "x".repeat(20_001) },
  { ...report(), summary: 5 },
  { ...report(), checks: null },
  { ...report(), checks: [] },
  { ...report(), checks: [report().checks[0], report().checks[0]] },
  {
    ...report(),
    checks: [
      { name: "other", verdict: "passed", evidence: "safe" },
      report().checks[1],
    ],
  },
  {
    ...report(),
    checks: [
      { name: "title", verdict: "other", evidence: "safe" },
      report().checks[1],
    ],
  },
  {
    ...report(),
    checks: [
      { name: "title", verdict: "passed", evidence: "" },
      report().checks[1],
    ],
  },
  { ...report(), verdict: "failed" },
];

for (const [index, invalid] of invalidReports.entries()) {
  test(`should retain inconclusive checks when report shape ${index} is invalid`, async (t) => {
    const { reporter, save } = await setup(t);
    await save(invalid);
    const result = reporter.readReport();
    assert.equal(result.verdict, "inconclusive");
    assert.deepEqual(
      result.checks.map((check) => check.name),
      checks,
    );
    assert.ok(result.checks.every((check) => check.verdict === "inconclusive"));
  });
}

for (const content of [undefined, "{invalid", "x".repeat(1_000_001)]) {
  test(`should report a safe diagnostic when report is ${content === undefined ? "missing" : content.length > 100 ? "oversized" : "malformed"}`, async (t) => {
    const { reporter, outputRoot } = await setup(t);
    if (content !== undefined)
      await writeFile(join(outputRoot, "agent-report.json"), content);
    assert.equal(
      reporter.readReport().summary,
      "Agent report is missing, unreadable, or invalid. Assessment could not be established.",
    );
  });
}
