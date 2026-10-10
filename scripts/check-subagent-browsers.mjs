import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL(
    "../apps/desktop/src-tauri/src/browser_background_pointer.js",
    import.meta.url,
  ),
  "utf8",
);
const createPointer = vm.runInNewContext(source);

function page() {
  const events = [];
  let focused = false;
  let blocked = false;
  let sensitiveDestination = false;
  const element = {
    closest: () => null,
    focus: () => {
      focused = true;
    },
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    },
  };
  class PageEvent {
    constructor(type, options) {
      this.type = type;
      Object.assign(this, options);
    }
  }
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    PointerEvent: PageEvent,
    MouseEvent: PageEvent,
  };
  const document = { elementFromPoint: () => element };
  const agent = {
    pointerTarget: ({ x }) => ({
      ok: true,
      blocked,
      sensitive: sensitiveDestination && x > 100,
      blockedReason: blocked ? "protected target" : undefined,
    }),
  };
  return {
    events,
    run: createPointer(agent, window, document),
    get focused() {
      return focused;
    },
    block: () => {
      blocked = true;
    },
    sensitiveDestination: () => {
      sensitiveDestination = true;
    },
  };
}

const parent = page();
const first = page();
const second = page();
const click = first.run({ action: "click", x: 40, y: 50 });
assert.equal(click.ok, true);
assert.equal(click.inputMode, "page-events");
assert.match(click.verification, /cannot provide trusted OS events/);
assert.deepEqual(
  first.events.slice(-5).map((event) => event.type),
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"],
);
assert.equal(first.events.at(-1).clientX, 40);
assert.equal(first.events.at(-1).clientY, 50);
assert.equal(first.focused, true);
assert.equal(parent.events.length, 0);
assert.equal(second.events.length, 0);
assert.equal(parent.focused, false);

assert.equal(second.run({ action: "hover", x: 20, y: 30 }).ok, true);
assert.ok(second.events.some((event) => event.type === "mouseenter"));
assert.ok(
  second.events.every(
    (event) => !["click", "pointerdown", "mousedown"].includes(event.type),
  ),
);
assert.equal(second.focused, false);

const drag = page();
assert.equal(
  drag.run({ action: "drag", x: 10, y: 20, toX: 200, toY: 300 }).ok,
  true,
);
assert.equal(drag.events.at(-1).type, "mouseup");
assert.equal(drag.events.at(-1).clientX, 200);
assert.equal(drag.events.at(-1).clientY, 300);
assert.equal(
  drag.events.filter(
    (event) => event.type === "pointermove" && event.buttons === 1,
  ).length,
  12,
);

const secondary = page();
assert.equal(
  secondary.run({ action: "secondary-click", x: 10, y: 20 }).ok,
  true,
);
assert.equal(secondary.events.at(-1).type, "contextmenu");
assert.equal(secondary.events.at(-1).button, 2);

for (const args of [
  { action: "click", x: -1, y: 20 },
  { action: "click", x: 1280, y: 20 },
  { action: "click", x: NaN, y: 20 },
  { action: "drag", x: 10, y: 20, toX: 50, toY: 800 },
  { action: "unsupported", x: 10, y: 20 },
]) {
  const invalid = page();
  assert.equal(invalid.run(args).ok, false);
  assert.equal(invalid.events.length, 0);
}
const protectedPage = page();
protectedPage.block();
assert.equal(protectedPage.run({ action: "click", x: 10, y: 20 }).ok, false);
assert.equal(protectedPage.events.length, 0);
const sensitive = page();
sensitive.sensitiveDestination();
assert.equal(
  sensitive.run({ action: "drag", x: 10, y: 20, toX: 200, toY: 30 }).ok,
  false,
);
assert.equal(sensitive.events.length, 0);

// Native presentation wiring must keep all three frontend event paths private,
// while the child still receives its normal capability-call process events.
const browser = readFileSync(
  new URL("../apps/desktop/src-tauri/src/session_browser.rs", import.meta.url),
  "utf8",
);
const native = readFileSync(
  new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
// Compile the full injected agent, including the separately embedded factory.
// Rust format's doubled braces and constants are substituted as in production.
const injected = browser
  .slice(
    browser.indexOf("fn agent_initialization_script"),
    browser.indexOf("fn cors_response"),
  )
  .match(/r#"([\s\S]*?)"#/)?.[1]
  .replaceAll("{{", "{")
  .replaceAll("}}", "}")
  .replaceAll("{background_pointer}", source.trim().replace(/;$/, ""))
  .replaceAll(
    "{pointer_feedback}",
    readFileSync(
      new URL(
        "../apps/desktop/src-tauri/src/browser_pointer_feedback.js",
        import.meta.url,
      ),
      "utf8",
    )
      .trim()
      .replace(/;$/, ""),
  )
  .replaceAll("{nonce}", '"test-nonce"')
  .replace(
    /\{(MAX_[A-Z_]+)\}/g,
    (_, name) =>
      browser.match(new RegExp(`const ${name}: [^=]+ = (\\d+);`))?.[1] ?? "100",
  );
assert.ok(injected);
new vm.Script(injected);
const installedEvents = [];
class InstalledEvent {
  constructor(type, options) {
    this.type = type;
    Object.assign(this, options);
  }
}
const installedTarget = {
  closest: () => null,
  focus() {},
  dispatchEvent(event) {
    installedEvents.push(event);
    return true;
  },
};
const installedWindow = {
  fetch: async () => ({}),
  innerWidth: 1280,
  innerHeight: 800,
  PointerEvent: InstalledEvent,
  MouseEvent: InstalledEvent,
};
const quietConsole = Object.fromEntries(
  ["log", "info", "warn", "error", "debug"].map((name) => [name, () => {}]),
);
vm.runInNewContext(injected, {
  window: installedWindow,
  document: { elementFromPoint: () => installedTarget },
  console: quietConsole,
  addEventListener() {},
});
installedWindow.__gyroBrowserAgent.pointerTarget = () => ({ ok: true });
assert.equal(
  installedWindow.__gyroBrowserAgent.backgroundPointer({
    action: "click",
    x: 30,
    y: 40,
  }).ok,
  true,
);
assert.equal(installedEvents.at(-1).type, "click");
assert.match(browser, /if snapshot.background_only \{\s*return call_agent\(/);
assert.match(browser, /if manager.background_only\(session_id\)\? \{/);
assert.match(
  browser,
  /browser_visibility\(manager.background_only\(session_id\)\?, visible\)/,
);
assert.match(
  browser,
  /!matches!\(kind, "console" \| "network"\) && !is_background_browser/,
);
assert.equal(
  (
    browser.match(
      /if !background_only \{\s*let _ = app_for_(load|title).emit\(/g,
    ) ?? []
  ).length,
  2,
);
assert.match(
  native,
  /if !snapshot.background_only \{\s*let _ = app.emit\(\s*"session-browser-opened"/,
);
assert.match(
  native,
  /resource.kind != "browser"\s*\|\| !session_browser::is_background_browser/,
);
assert.match(
  browser,
  /background_throttling\([\s\S]*?BackgroundThrottlingPolicy::Disabled/,
);
assert.match(browser, /incognito\(true\)/);
console.log(
  "sub-agent browsers: private input, independent pages, protected targets, and hidden frontend routing passed",
);
