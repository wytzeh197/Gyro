const { chromium } = require("./stageshow/node_modules/playwright-core");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    executablePath:
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:1429/account-cloud-review.html");
  await page.waitForTimeout(800);
  const account = page.locator(".window");
  await account.getByLabel("Display name", { exact: true }).fill("Alex");
  await account.getByLabel("Simulate a failed name save").check();
  await account.getByRole("button", { name: "Save", exact: true }).click();
  assert(await account.getByRole("alert").isVisible());
  assert.equal(
    await account.getByLabel("Display name", { exact: true }).inputValue(),
    "Alex",
  );
  await account.getByLabel("Simulate a failed name save").uncheck();
  await account.getByRole("button", { name: "Save", exact: true }).click();
  assert((await account.locator(".identity").innerText()).includes("Alex"));
  await account.getByRole("button", { name: "Sign out", exact: true }).click();
  assert.equal(await account.locator(".cloud-link").count(), 0);
  await account.getByRole("button", { name: "Sign in", exact: true }).click();
  await account
    .getByRole("button", { name: "Continue preview", exact: true })
    .click();
  assert.equal(await account.locator(".cloud-link").count(), 1);
  const library = page.locator(".library-preview");
  await library
    .getByRole("button", { name: "Restore", exact: true })
    .first()
    .click();
  assert.equal(
    await library
      .getByRole("button", { name: "Restored", exact: true })
      .count(),
    1,
  );
  for (let i = 0; i < 3; i++) {
    await library
      .getByRole("button", { name: /More actions/ })
      .first()
      .click();
    await library
      .getByRole("button", { name: "Delete cloud copy", exact: true })
      .click();
    await library
      .locator(".confirmation")
      .getByRole("button", { name: "Delete cloud copy", exact: true })
      .click();
  }
  assert(await library.getByText(/No cloud chats yet/).isVisible());
  const setup = page.locator(".state-grid article").nth(2);
  await setup.getByRole("button", { name: "Set up backup" }).click();
  assert(await setup.getByRole("button", { name: "Copy code" }).isVisible());
  await setup.getByRole("button", { name: "I saved the code" }).click();
  assert(
    await setup.getByRole("button", { name: "Open Cloud Chats" }).isVisible(),
  );
  const locked = page.locator(".state-grid article").nth(1);
  await locked.getByRole("button", { name: "Unlock backup" }).click();
  assert(
    await locked.getByRole("button", { name: "Open Cloud Chats" }).isVisible(),
  );
  const edges = page.locator(".edge-cases .review-sidebar");
  assert((await edges.nth(0).innerText()).includes("Add your name"));
  assert.equal(await edges.nth(1).locator(".identity small").count(), 0);
  assert((await edges.nth(2).innerText()).includes("Unlock backup"));
  await page.setViewportSize({ width: 860, height: 620 });
  await page.reload();
  await page.waitForTimeout(500);
  await page.keyboard.press("Tab");
  assert(
    await page.evaluate(
      () => getComputedStyle(document.activeElement).outlineStyle !== "none",
    ),
  );
  await page.addStyleTag({
    content:
      ".review button,.review label,.review p,.review small,.review .identity strong{font-size:18px!important}",
  });
  await page.waitForTimeout(500);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: require("node:path").join(__dirname, "large-text.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS name error/retry, sidebar sync, sign-out/sign-in, restore, delete/empty library, setup, unlock, long email, absent plan, keyboard focus, 860×620 larger text.",
  );
  await browser.close();
})();
