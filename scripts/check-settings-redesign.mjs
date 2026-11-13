import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Production settings components with fixture-only data. No provider calls,
// native permission requests, real imports, account changes or payments.
const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const output = "artifacts/settings-implementation-2026-11-12";
const browserPath =
  process.env.GYRO_CAPTURE_BROWSER ||
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-settings-review-"));
const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=9478",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await delay(100);
  }
  throw Error("Timed out waiting for settings");
}
let ws;
const results = [],
  exceptions = [],
  interactions = [],
  failures = [];
try {
  const targets = await until(async () =>
    (await fetch("http://127.0.0.1:9478/json/list")).json(),
  );
  ws = new WebSocket(
    targets.find((x) => x.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const response = JSON.parse(event.data);
    if (response.method === "Runtime.exceptionThrown")
      exceptions.push(response.params.exceptionDetails);
    if (pending.has(response.id)) {
      const callback = pending.get(response.id);
      pending.delete(response.id);
      response.error
        ? callback.reject(response.error)
        : callback.resolve(response.result);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Page.enable");
  await call("Runtime.enable");
  const setViewport = (width, height) =>
    call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  const navigate = async (section, theme = "dark", extra = "") => {
    const query = new URLSearchParams({
      section,
      theme,
      account: "ready",
      connected: "openai",
    });
    for (const [key, value] of new URLSearchParams(extra))
      query.set(key, value);
    await call("Page.navigate", {
      url: `${origin}/settings-preview.html?${query}`,
    });
    await until(() =>
      evaluate(
        `!!document.querySelector('[data-settings-page="${section}"] h1')`,
      ),
    );
    await delay(200);
  };
  const capture = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, "base64"));
  };
  const inspect = () =>
    evaluate(`(() => {
    const surface = document.querySelector(".gyro-settings-surface");
    const content = document.querySelector(".gyro-settings-content");
    const visible = element => !!element.getClientRects().length && getComputedStyle(element).visibility !== "hidden" && !element.closest("[hidden]");
    const overflow = [...content.querySelectorAll(".gyro-settings-row,.gyro-settings-group-rows,.gyro-settings-disclosure-body,.gyro-provider-row,.gyro-workspace-keybindings label,.gyro-workspace-settings-list label,.gyro-help-topic summary,.gyro-cli-profiles-table")]
      .filter(visible).filter(element => element.scrollWidth > element.clientWidth + 2)
      .map(element => ({class: element.className, text: element.textContent.trim().slice(0,70), width: element.clientWidth, scroll: element.scrollWidth}));
    const headings = [...content.querySelectorAll(".is-open-section > .gyro-settings-group-heading h2")].map(x=>x.textContent);
    return {title:content.querySelector("h1").textContent, headings, overflow,
      pageOverflow:surface.scrollWidth > surface.clientWidth+2,
      titleSize:getComputedStyle(content.querySelector("h1")).fontSize,
      primaryButtons:[...content.querySelectorAll("button.gyro-primary-button")].filter(visible).filter(x=>!x.disabled).length};
  })()`);
  const pages = [
    "general",
    "appearance",
    "keyboard",
    "providers",
    "efficiency",
    "usage-limits",
    "cli-profiles",
    "permissions",
    "editor-workspace",
    "import-projects",
    "tools-contributions",
    "cloud",
    "billing",
    "advanced",
    "updates",
    "about",
    "account",
  ];
  const variants = process.argv.includes("--one")
    ? [
        {
          theme: "dark",
          width: 1440,
          height: 1000,
          size: "default",
          density: "comfortable",
          name: "dark",
        },
      ]
    : [
        {
          theme: "dark",
          width: 1440,
          height: 1000,
          size: "default",
          density: "comfortable",
          name: "dark",
        },
        {
          theme: "light",
          width: 1440,
          height: 1000,
          size: "default",
          density: "comfortable",
          name: "light",
        },
        {
          theme: "dark",
          width: 860,
          height: 620,
          size: "large",
          density: "compact",
          name: "narrow-dark",
        },
        {
          theme: "light",
          width: 860,
          height: 620,
          size: "large",
          density: "comfortable",
          name: "narrow-light",
        },
      ];
  for (const variant of variants) {
    await setViewport(variant.width, variant.height);
    for (const section of process.argv.includes("--one")
      ? ["general"]
      : pages) {
      const unavailable = ["cloud", "billing"].includes(section)
        ? "cloudUnavailable&"
        : "";
      await navigate(
        section,
        variant.theme,
        `${unavailable}size=${variant.size}&density=${variant.density}&state=${section === "updates" ? "current" : "idle"}`,
      );
      const metrics = await inspect();
      if (section === "general") {
        const highlights = await evaluate(`(() => {
          const toggle = document.querySelector(".gyro-settings-switch.is-on");
          return {
            accent: getComputedStyle(document.documentElement).getPropertyValue("--gyro-accent").trim(),
            track: getComputedStyle(toggle).backgroundColor,
            thumb: getComputedStyle(toggle.firstElementChild).backgroundColor,
          };
        })()`);
        assert.equal(highlights.accent, variant.theme === "dark" ? "#ffffff" : "#000000");
        assert.notEqual(highlights.track, highlights.thumb, "The switch thumb must remain visible");
        metrics.highlights = highlights;
      }
      results.push({ section, variant: variant.name, ...metrics });
      if (metrics.pageOverflow || metrics.overflow.length)
        failures.push({ section, variant: variant.name, ...metrics });
      await capture(`${section}-${variant.name}`);
      if (variant.name === "dark") {
        await evaluate('document.querySelector(".gyro-settings-surface").scrollTop = document.querySelector(".gyro-settings-surface").scrollHeight');
        await delay(100);
        await capture(`${section}-dark-bottom`);
      }
    }
    console.log(
      `Captured ${variant.name}: ${results.length} page checks so far`,
    );
  }
  if (!process.argv.includes("--one")) {
    await setViewport(1440, 1000);
    const test = async (name, fn) => {
      await fn();
      interactions.push(name);
      console.log("PASS " + name);
    };
    await test("ordinary groups stay open and switches update", async () => {
      await navigate("general");
      assert.ok(
        await evaluate(
          '!!document.querySelector("#app-behavior select")?.getClientRects().length',
        ),
      );
      const before = await evaluate(
        'document.querySelector("[aria-label=\\"Show Gyro in menu bar\\"]").getAttribute("aria-checked")',
      );
      await evaluate(
        'document.querySelector("[aria-label=\\"Show Gyro in menu bar\\"]").click()',
      );
      assert.notEqual(
        await evaluate(
          'document.querySelector("[aria-label=\\"Show Gyro in menu bar\\"]").getAttribute("aria-checked")',
        ),
        before,
      );
    });
    await test("appearance theme changes and save failures remain visible", async () => {
      await navigate("appearance", "dark", "failSave");
      await evaluate(
        'document.querySelector("[aria-label=\\"Light theme\\"]").click()',
      );
      await until(() =>
        evaluate('document.documentElement.dataset.theme === "light"'),
      );
      await until(() =>
        evaluate(
          '!!document.querySelector(".gyro-appearance-save-status.is-error")',
        ),
      );
      assert.ok(
        await evaluate('document.body.innerText.includes("Retry save")'),
      );
      await capture("appearance-save-error");
    });
    await test("shortcut search filters app and editable workspace shortcuts", async () => {
      await navigate("keyboard");
      await evaluate(
        `(()=>{const x=document.querySelector('[aria-label="Search shortcuts"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"new chat");x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
      );
      await until(() =>
        evaluate(
          'document.querySelectorAll("#app-shortcuts .gyro-settings-row").length===1',
        ),
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#app-shortcuts .gyro-settings-row strong").textContent',
        ),
        "New chat",
      );
    });
    await test("Add provider reveals its form and moves focus", async () => {
      await navigate("providers");
      await evaluate(
        '[...document.querySelectorAll("button")].find(x=>x.textContent==="Add provider").click()',
      );
      await until(() =>
        evaluate(
          'document.querySelector("[data-settings-disclosure=\\"add-provider\\"] button[aria-expanded]").getAttribute("aria-expanded")==="true"',
        ),
      );
      assert.equal(
        await evaluate("document.activeElement.id"),
        "gyro-provider-accounts",
      );
      await capture("providers-add");
    });
    await test("advanced settings reveal on search and keep their controls mounted", async () => {
      await navigate("efficiency");
      assert.equal(
        await evaluate(
          'document.querySelector("[data-settings-disclosure=\\"advanced-context\\"] button[aria-expanded]").getAttribute("aria-expanded")',
        ),
        "false",
      );
      await evaluate(
        'document.querySelector("[data-setting-key=\\"task-profile\\"]").dispatchEvent(new CustomEvent("gyro:reveal-setting",{bubbles:true}))',
      );
      await until(() =>
        evaluate(
          'document.querySelector("[data-settings-disclosure=\\"advanced-context\\"] button[aria-expanded]").getAttribute("aria-expanded")==="true"',
        ),
      );
      await capture("efficiency-expanded");
    });
    await test("import scan moves from empty to review without importing", async () => {
      await navigate("import-projects");
      await evaluate(
        '[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Scan projects").click()',
      );
      await until(() =>
        evaluate('!!document.querySelector(".gyro-import-projects-toolbar")'),
      );
      await capture("import-scanned");
    });
    await test("Help search opens matching answers and handles no results", async () => {
      await navigate("about");
      const search = (term) =>
        evaluate(
          `(()=>{const x=document.querySelector('[aria-label="Search Help"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,${JSON.stringify(term)});x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
        );
      await search("provider");
      await until(() =>
        evaluate(
          'document.querySelectorAll(".gyro-help-topic details[open]").length > 0',
        ),
      );
      await search("nonexistent-help-question");
      await until(() =>
        evaluate('!!document.querySelector(".gyro-help-empty")'),
      );
    });
    await test("workspace scope preserves inherited controls", async () => {
      await navigate("editor-workspace");
      await evaluate(
        '[...document.querySelectorAll(".gyro-workspace-settings-scopes button")].find(x=>x.textContent==="Across Gyro").click()',
      );
      await until(() =>
        evaluate(
          'document.querySelector(".gyro-workspace-settings-scopes button").getAttribute("aria-pressed")==="true"',
        ),
      );
      assert.equal(
        await evaluate(
          'document.querySelectorAll("#files-search input").length',
        ),
        3,
      );
      assert.ok(await evaluate('!!document.querySelector("#editor select")'));
    });
    await test("reset opens confirmation and Escape cancels it", async () => {
      await navigate("advanced");
      await evaluate(
        '[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="Reset UI state").click()',
      );
      await until(() =>
        evaluate('!!document.querySelector("[role=alertdialog]")'),
      );
      await call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await until(() =>
        evaluate('!document.querySelector("[role=alertdialog]")'),
      );
    });
    await test("keyboard navigation has a visible focus ring", async () => {
      await navigate("general");
      await evaluate(
        'document.querySelector("[aria-label=\\"Open on launch\\"]").focus()',
      );
      await call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
      const focus = await evaluate(
        '({visible:document.activeElement.matches(":focus-visible"),outline:getComputedStyle(document.activeElement).outlineStyle})',
      );
      assert.equal(focus.visible, true);
      assert.notEqual(focus.outline, "none");
    });
    for (const [section, extra, name] of [
      [
        "account",
        "nativeAccount&cloudUnavailable",
        "account-native-unavailable",
      ],
      ["cloud", "", "cloud-connected"],
      ["account", "account=signed-out", "account-signed-out"],
      ["updates", "state=failed", "updates-failed"],
      ["updates", "state=downloading", "updates-downloading"],
    ]) {
      await navigate(section, "dark", extra);
      const metrics = await inspect();
      results.push({ section, variant: name, ...metrics });
      if (metrics.pageOverflow || metrics.overflow.length)
        failures.push({ section, variant: name, ...metrics });
      await capture(name);
    }
  }
  const report = { results, interactions, exceptions, failures };
  await writeFile(`${output}/layout.json`, JSON.stringify(report, null, 2));
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  assert.equal(failures.length, 0, JSON.stringify(failures));
  console.log(
    `PASS ${results.length} rendered layouts and ${interactions.length} interaction checks`,
  );
} finally {
  ws?.close();
  browser.kill();
  await delay(300);
  await rm(profile, { recursive: true, force: true });
}
