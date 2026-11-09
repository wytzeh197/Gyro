// Execute the shipped DOM agent in a fresh headless browser; no app or server needed.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseline = process.argv.includes("--baseline");
const sourcePath = "apps/desktop/src-tauri/src/session_browser.rs";
const source = baseline
  ? execFileSync("git", ["show", `HEAD:${sourcePath}`], { encoding: "utf8" })
  : await readFile(sourcePath, "utf8");
const start = source.indexOf(
  'r#"(function()',
  source.indexOf("fn agent_initialization_script"),
);
const end = source.indexOf('"#', start);
assert.ok(
  start >= 0 && end > start,
  "native browser agent source is available",
);
let agent = source
  .slice(start + 3, end)
  .replaceAll("{{", "{")
  .replaceAll("}}", "}");
for (const [key, value] of Object.entries({
  nonce: '"runtime-fixture"',
  MAX_CONSOLE_ENTRIES: 100,
  MAX_NETWORK_ENTRIES: 100,
  MAX_ENTRY_CHARS: 2000,
  MAX_TREE_CHARS: 48000,
  MAX_FIND_RESULTS: 40,
  pointer_feedback: await readFile(
    "apps/desktop/src-tauri/src/browser_pointer_feedback.js",
    "utf8",
  ),
  background_pointer: await readFile(
    "apps/desktop/src-tauri/src/browser_background_pointer.js",
    "utf8",
  ),
}))
  agent = agent.replaceAll(`{${key}}`, String(value).trim().replace(/;$/, ""));

const profile = await mkdtemp(join(tmpdir(), "gyro-browser-agent-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ||
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let launchError;
let browserErrors = "";
browser.stderr.on("data", (chunk) => {
  browserErrors = (browserErrors + String(chunk)).slice(-4000);
});
browser.on("error", (error) => {
  launchError = error;
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
const checks = [];
try {
  let port;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null)
      throw new Error(`Browser exited: ${browser.exitCode}`);
    try {
      port = Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      );
    } catch {}
    if (port) break;
    await pause(100);
  }
  assert.ok(port, `headless browser started: ${browserErrors}`);
  const pages = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  ws = new WebSocket(
    pages.find((page) => page.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const response = JSON.parse(String(data));
    const callback = pending.get(response.id);
    if (!callback) return;
    pending.delete(response.id);
    clearTimeout(callback.timer);
    response.error
      ? callback.reject(response.error)
      : callback.resolve(response.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Page.enable");
  const { frameTree } = await call("Page.getFrameTree");
  await call("Page.setDocumentContent", {
    frameId: frameTree.frame.id,
    html: `<!doctype html>
    <label for="project">Project name</label><input id="project">
    <span id="first">Launch</span><span id="second">preview</span>
    <button aria-labelledby="first second" id="labelled">Icon</button>
    <button id="keep">Keep reference</button>
    <section id="subtree"><button>Nested</button></section>
    <fieldset disabled><input id="disabled" type="checkbox"><button id="disabled-button">Disabled</button></fieldset>
    <select id="choices"><option value="site">Site</option><option value="app">App</option></select>
    <div id="many"></div>`,
  });
  await evaluate(agent);
  const check = async (name, expression) => {
    const passed = await evaluate(expression);
    checks.push({ name, passed });
    if (!baseline) assert.equal(passed, true, name);
  };
  await check(
    "find resolves associated form labels",
    `(() => {
    const result = __gyroBrowserAgent.find({query:'Project name'});
    return result.results.some(item => item.tag === 'input' && item.name === 'Project name');
  })()`,
  );
  await check(
    "find resolves aria-labelledby in order",
    `(() => {
    const result = __gyroBrowserAgent.find({selector:'#labelled'});
    return result.results[0].name === 'Launch preview';
  })()`,
  );
  await check(
    "subtree reads preserve other connected refs",
    `(() => {
    const keep = __gyroBrowserAgent.find({selector:'#keep'}).results[0].ref;
    const subtree = __gyroBrowserAgent.find({selector:'#subtree'}).results[0].ref;
    __gyroBrowserAgent.readPage({ref:subtree});
    return __gyroBrowserAgent.click({ref:keep}).ok === true;
  })()`,
  );
  await check(
    "disabled fields fail without changes",
    `(() => {
    const ref = __gyroBrowserAgent.find({selector:'#disabled'}).results[0].ref;
    return __gyroBrowserAgent.formInput({ref,value:'true'}).ok === false && !document.querySelector('#disabled').checked;
  })()`,
  );
  await check(
    "disabled clicks report failure",
    `(() => {
    const ref = __gyroBrowserAgent.find({selector:'#disabled-button'}).results[0].ref;
    return __gyroBrowserAgent.click({ref}).ok === false;
  })()`,
  );
  await check(
    "missing select option fails without clearing selection",
    `(() => {
    const ref = __gyroBrowserAgent.find({selector:'#choices'}).results[0].ref;
    return __gyroBrowserAgent.formInput({ref,value:'missing'}).ok === false && document.querySelector('#choices').value === 'site';
  })()`,
  );
  await check(
    "disconnected refs fail without acting",
    `(() => {
    const ref = __gyroBrowserAgent.find({selector:'#keep'}).results[0].ref;
    document.querySelector('#keep').remove();
    return __gyroBrowserAgent.click({ref}).ok === false;
  })()`,
  );
  await check(
    "breadth limits report incomplete observations",
    `(() => {
    document.querySelector('#many').innerHTML = '<button>Action</button>'.repeat(60);
    const ref = __gyroBrowserAgent.find({selector:'#many'}).results[0].ref;
    return __gyroBrowserAgent.readPage({ref,maxDepth:8,maxChars:48000}).truncated === true;
  })()`,
  );
  await check(
    "depth limits report incomplete observations",
    `(() => {
    const ref = __gyroBrowserAgent.find({selector:'#subtree'}).results[0].ref;
    return __gyroBrowserAgent.readPage({ref,maxDepth:1}).truncated === true;
  })()`,
  );
  await check(
    "hidden-node traversal is bounded and reported",
    `(() => {
    const root = document.querySelector('#many');
    root.innerHTML = '<span hidden></span>'.repeat(6000) + '<button>Last</button>';
    const ref = __gyroBrowserAgent.find({selector:'#many'}).results[0].ref;
    const original = window.getComputedStyle;
    let visited = 0;
    window.getComputedStyle = (...args) => { visited++; return original.apply(window,args); };
    const page = __gyroBrowserAgent.readPage({ref,maxDepth:8,maxChars:48000});
    window.getComputedStyle = original;
    return page.truncated === true && visited <= 5000;
  })()`,
  );
  // Count expensive text reads, then measure the complete readPage boundary.
  const performance = await evaluate(`(() => {
    const root = document.querySelector('#many');
    root.innerHTML = Array.from({length:35}, () => '<section><div><button>' + 'Visible content '.repeat(500) + '</button></div></section>').join('');
    const ref = __gyroBrowserAgent.find({selector:'#many'}).results[0].ref;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
    let textReads = 0;
    Object.defineProperty(HTMLElement.prototype, 'innerText', {...descriptor, get() { textReads++; return descriptor.get.call(this); }});
    const samples = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      __gyroBrowserAgent.readPage({ref,maxDepth:8,maxChars:48000});
      samples.push(performance.now() - start);
    }
    Object.defineProperty(HTMLElement.prototype, 'innerText', descriptor);
    samples.sort((a,b) => a-b);
    return { samples: samples.length, medianMs:samples[12], slowestMs:samples.at(-1), textReadsPerCall:textReads/25 };
  })()`);
  const previousDocumentRef = await evaluate(
    "__gyroBrowserAgent.find({selector:'label'}).results[0].ref",
  );
  await call("Page.navigate", {
    url: "data:text/html,<button>New document target</button>",
  });
  let navigated = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await evaluate(
        "location.protocol === 'data:' && document.readyState === 'complete'",
      )
    ) {
      navigated = true;
      break;
    }
    await pause(20);
  }
  assert.ok(navigated, "isolated navigation completed");
  await evaluate(agent);
  await check(
    "previous-document refs never alias new targets",
    `(() => {
    const ref = __gyroBrowserAgent.find({selector:'button'}).results[0].ref;
    return ref !== ${JSON.stringify(previousDocumentRef)}
      && __gyroBrowserAgent.click({ref:${JSON.stringify(previousDocumentRef)}}).ok === false;
  })()`,
  );
  console.log(JSON.stringify({ baseline, checks, performance }, null, 2));
} finally {
  ws?.close();
  if (browser.exitCode === null && browser.pid) {
    browser.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => browser.once("exit", resolve)),
      pause(3000),
    ]);
    if (browser.exitCode === null) browser.kill("SIGKILL");
  }
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
