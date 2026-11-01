// Browser-only acceptance of production components with development fixture data.
// Run with the desktop Vite server on 1420. No native or provider actions run.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(
  process.env.GYRO_PLAYWRIGHT_MODULE ??
    "/Users/wytze/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs"
);
const browser = await chromium.launch({
  executablePath:
    process.env.GYRO_CAPTURE_BROWSER ??
    "/Users/wytze/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  headless: true,
});
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420";
const output = join(dirname(fileURLToPath(import.meta.url)), "after");
await mkdir(output, { recursive: true });
const results = [];
const page = await browser.newPage({ deviceScaleFactor: 1 });
page.setDefaultTimeout(10000);
let errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
const settings = {
  general: "General",
  appearance: "Appearance",
  providers: "Models & Accounts",
  keyboard: "Keyboard Shortcuts",
  usage: "Usage & Limits",
  tools: "Tools",
  updates: "Updates",
};

async function capture(scene, theme, viewport, size = "default", accent) {
  errors = [];
  await page.setViewportSize(viewport);
  const params = new URLSearchParams({
    reset: "1",
    scene: scene === "chat" ? "active-chat" : "welcome",
    theme,
    size,
    density: size === "large" ? "comfortable" : "compact",
  });
  if (accent) params.set("accent", accent);
  await page.goto(`${origin}/capture.html?${params}`);
  await page.waitForSelector(".gyro-app-shell");
  if (scene === "chat") {
    await page.getByRole("button", { name: /Bound the sync/ }).first().click();
    await page.waitForSelector(".gyro-chat-turn");
  } else if (settings[scene]) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: settings[scene], exact: true }).click();
  } else if (scene === "workspace") {
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("button", { name: /^Source Control/ }).click();
  } else if (scene === "automations") {
    await page.getByRole("button", { name: "Automations", exact: true }).click();
  } else if (scene === "search") {
    await page.getByRole("button", { name: /^Search/ }).click();
  } else if (scene === "session-menu") {
    await page.locator(".gyro-session-row").first().hover();
    await page.locator(".gyro-session-action.is-more").first().click();
  }
  await page.mouse.move(viewport.width - 2, viewport.height - 2);
  await page.waitForTimeout(350);
  const name = `${scene}-${theme}-${viewport.width}-${size}${accent ? "-accent" : ""}`;
  const geometry = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.getBoundingClientRect().toJSON() : null;
    };
    return {
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      send: box(".gyro-send-button"),
      composer: box(".gyro-composer-shell"),
      menu: box(".gyro-session-menu"),
      search: box(".gyro-command-palette"),
    };
  });
  await page.screenshot({ path: join(output, `${name}.png`) });
  assert.ok(geometry.scrollWidth <= viewport.width + 1, `${name}: horizontal overflow`);
  assert.ok(geometry.scrollHeight <= viewport.height + 1, `${name}: shell vertical overflow`);
  if (geometry.send) {
    assert.ok(Math.abs(geometry.send.width - geometry.send.height) <= 1, `${name}: Send must stay round`);
  }
  for (const key of ["menu", "search", "composer"]) {
    const rect = geometry[key];
    if (rect) {
      assert.ok(rect.x >= -1 && rect.right <= viewport.width + 1, `${name}: ${key} horizontal bounds`);
      assert.ok(rect.y >= -1 && rect.bottom <= viewport.height + 1, `${name}: ${key} vertical bounds`);
    }
  }
  assert.deepEqual(errors, [], `${name}: runtime errors`);
  results.push({ name, geometry, errors: [...errors] });
  console.log(`PASS ${name}`);
}

try {
  for (const theme of ["dark", "light"]) {
    for (const scene of ["welcome", "chat", "appearance", "providers", "workspace", "automations"]) {
      await capture(scene, theme, { width: 1440, height: 900 });
      await capture(scene, theme, { width: 860, height: 620 }, "large");
    }
    for (const scene of ["general", "keyboard", "usage", "tools", "updates", "search", "session-menu"]) {
      await capture(scene, theme, { width: 860, height: 620 }, "large");
    }
    await capture("welcome", theme, { width: 1024, height: 700 }, "small", "8654c7");
  }
  // Exercise ordinary navigation with keyboard focus and menu dismissal.
  await page.locator(".gyro-session-row").first().hover();
  await page.locator(".gyro-session-action.is-more").first().click();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator('[role="menuitem"]').first().evaluate(e => e === document.activeElement), true);
  await page.keyboard.press("End");
  assert.equal(await page.locator('[role="menuitem"]').last().evaluate(e => e === document.activeElement), true);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".gyro-session-menu", { state: "detached" });
  assert.equal(await page.locator(".gyro-session-action.is-more").first().evaluate(e => e === document.activeElement), true);
  console.log("PASS session menu keyboard navigation, dismissal, and focus return");
} finally {
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
