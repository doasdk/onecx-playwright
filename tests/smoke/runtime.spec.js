const { test, expect } = require("@playwright/test");
const { accessSync, constants } = require("node:fs");

test("should expose the envelope environment when inherited launcher consumes the contract", () => {
  test.skip(process.env.CONTRACT_SMOKE !== "true");
  expect(process.env.ENV).toBe("container");
  expect(process.env.BASE_URL).toBe("https://onecx.test/");
  expect(process.env.ENVIRONMENTS_JSON).toBe("{}");
  expect(process.env.TEST_DATA_JSON).toBe("{}");
  expect(process.env.PLATFORM_INFO_JSON).toBe("{}");
  expect(process.env.CAPTURE_PRIVATE_ARTIFACTS).toBe("false");
});

test("should expose the platform CA to Node when the launcher supplies a CA path", () => {
  expect(process.env.NODE_EXTRA_CA_CERTS).toBe(process.env.TLS_CA_CERT_PATH);
});

test("should provide a writable artifact directory when the launcher starts tests", () => {
  expect(() => accessSync(process.env.OUTPUT_DIR, constants.W_OK)).not.toThrow();
});

test("should render an app page when the runtime launches the browser", async ({
  page,
}) => {
  await page.route("https://onecx.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="en"><title>OneCX runtime</title><h1>Runtime ready</h1></html>',
    }),
  );
  await page.goto("https://onecx.test/");
  await expect(page.locator("h1")).toHaveText("Runtime ready");
});
