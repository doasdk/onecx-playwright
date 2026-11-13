const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const original = "const runDir = (0, artifacts_1.resolveRunArtifactsDir)(root, effectiveRunId);";

test("should patch the supported implementation idempotently", async () => {
  const { patchRunContext } = await import("../orchestrator/compatibility/patch-run-context.mjs");
  const patched = patchRunContext(original);
  assert.equal(patchRunContext(patched), patched);
});

test("should reject an unknown implementation", async () => {
  const { patchRunContext } = await import("../orchestrator/compatibility/patch-run-context.mjs");
  assert.throws(() => patchRunContext("unexpected"), /Unexpected run-context/);
});

for (const [name, root, base, expected] of [
  ["configured work directory", undefined, "custom-work/run-1", path.resolve("custom-work/run-1")],
  ["explicit root", "/explicit", "/custom", "/explicit/run-1"],
  ["default directory", undefined, undefined, "/default/run-1"],
  ["empty setting", undefined, " ", "/default/run-1"],
]) {
  test(`should resolve exported CA paths using ${name}`, async () => {
    const { patchRunContext } = await import("../orchestrator/compatibility/patch-run-context.mjs");
    const result = vm.runInNewContext(`${patchRunContext(original)} runDir`, {
      root,
      effectiveRunId: "run-1",
      path,
      process: { env: { E2E_BASE_DIR: base } },
      artifacts_1: { resolveRunArtifactsDir: (value, id) => `${value || "/default"}/${id}` },
    });
    assert.equal(result, expected);
  });
}
