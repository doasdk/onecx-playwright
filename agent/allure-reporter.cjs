const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  ReporterRuntime,
  createDefaultWriter,
} = require("allure-js-commons/sdk/reporter");

const statuses = { passed: "passed", failed: "failed", inconclusive: "broken" };

class AgentAllureReporter {
  constructor({ outputRoot, requiredChecks, suite = "Browser assessment" }) {
    this.outputRoot = outputRoot;
    this.requiredChecks = requiredChecks;
    this.suite = suite;
    this.failed = false;
    this.runtime = new ReporterRuntime({
      writer: createDefaultWriter({
        resultsDir: join(outputRoot, "allure-results"),
      }),
    });
  }

  readReport() {
    try {
      const raw = readFileSync(
        join(this.outputRoot, "agent-report.json"),
        "utf8",
      );
      if (raw.length > 1_000_000) throw new Error();
      const report = JSON.parse(raw);
      const text = (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 20_000;
      if (
        report.schemaVersion !== 1 ||
        !Object.hasOwn(statuses, report.verdict) ||
        !text(report.summary) ||
        !Array.isArray(report.checks) ||
        report.checks.length !== this.requiredChecks.length ||
        new Set(report.checks.map((check) => check.name)).size !==
          this.requiredChecks.length ||
        report.checks.some(
          (check) =>
            !this.requiredChecks.includes(check.name) ||
            !Object.hasOwn(statuses, check.verdict) ||
            !text(check.evidence),
        )
      )
        throw new Error();
      const verdict = report.checks.some((check) => check.verdict === "failed")
        ? "failed"
        : report.checks.some((check) => check.verdict === "inconclusive")
          ? "inconclusive"
          : "passed";
      if (report.verdict !== verdict) throw new Error();
      return {
        schemaVersion: 1,
        verdict,
        summary: report.summary,
        checks: report.checks.map(({ name, verdict, evidence }) => ({
          name,
          verdict,
          evidence,
        })),
      };
    } catch {
      return {
        schemaVersion: 1,
        verdict: "inconclusive",
        summary:
          "Agent report is missing, unreadable, or invalid. Assessment could not be established.",
        checks: this.requiredChecks.map((name) => ({
          name,
          verdict: "inconclusive",
          evidence: "No valid agent observation is available.",
        })),
      };
    }
  }

  onTestEnd(test, result) {
    const report = this.readReport();
    const prepared = test.annotations.some(
      (annotation) => annotation.type === "agent-prepared",
    );
    const status = !prepared
      ? "broken"
      : result.status === "passed"
        ? statuses[report.verdict]
        : report.verdict === "failed"
          ? "failed"
          : "broken";
    this.failed ||= status !== "passed";
    const uuid = this.runtime.startTest({
      name: test.title,
      fullName: test.id,
      historyId: test.id,
      start: result.startTime.getTime(),
      status,
      stage: "finished",
      description: report.summary,
      statusDetails: { message: report.summary },
      labels: [
        { name: "parentSuite", value: "Prompt-driven browser tests" },
        { name: "suite", value: this.suite },
      ],
      steps: [
        {
          name: "Deterministic authentication and page readiness",
          status: prepared ? "passed" : "broken",
          statusDetails: {
            message: prepared
              ? "Existing authenticated-page fixture opened and verified the target page."
              : "Authenticated preparation did not complete; the agent was not started.",
          },
          steps: [],
          attachments: [],
          parameters: [],
        },
        ...report.checks.map((check) => ({
          name: check.name,
          status: statuses[check.verdict],
          statusDetails: { message: check.evidence },
          steps: [],
          attachments: [],
          parameters: [],
        })),
      ],
    });
    this.runtime.writeAttachment(
      uuid,
      undefined,
      "Sanitized agent assessment",
      Buffer.from(JSON.stringify(report, null, 2)),
      { contentType: "application/json", fileExtension: "json" },
    );
    for (const attachment of result.attachments) {
      const video =
        attachment.name === "Agent assessment video" &&
        attachment.contentType === "video/webm";
      const screenshot =
        status !== "passed" &&
        attachment.name === "Agent failure screenshot" &&
        attachment.contentType === "image/png";
      if (video || screenshot) {
        this.runtime.writeAttachment(
          uuid,
          undefined,
          attachment.name,
          attachment.body || attachment.path,
          {
            contentType: attachment.contentType,
            fileExtension: video ? "webm" : "png",
          },
        );
      }
    }
    this.runtime.stopTest(uuid, { duration: result.duration });
    this.runtime.writeTest(uuid);
  }

  onEnd() {
    if (this.failed) return { status: "failed" };
  }
}

module.exports = AgentAllureReporter;
