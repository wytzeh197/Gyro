import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const profile = await mkdtemp(join(tmpdir(), "gyro-media-qa-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ||
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=" + profile,
    "--remote-debugging-port=9487",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws;
async function until(check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + label);
}
try {
  const pages = await until(
    async () => (await fetch("http://127.0.0.1:9487/json/list")).json(),
    "browser startup",
  );
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
    if (callback) {
      pending.delete(response.id);
      response.error
        ? callback.reject(response.error)
        : callback.resolve(response.result);
    }
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await call("Page.enable");
  await call("Page.navigate", {
    url: origin + "/media-reliability-fixture.html",
  });
  await until(
    () =>
      evaluate("document.querySelectorAll('.gyro-send-button').length === 2"),
    "actual chat components",
  );
  for (const theme of ["light", "dark"]) {
    for (const size of ["0.9", "1", "1.15"]) {
      await evaluate(
        "(() => { const a=document.querySelector('[aria-label=\"Theme\"]'); a.value=" +
          JSON.stringify(theme) +
          "; a.dispatchEvent(new Event('change',{bubbles:true})); const b=document.querySelector('[aria-label=\"Size\"]'); b.value=" +
          JSON.stringify(size) +
          "; b.dispatchEvent(new Event('change',{bubbles:true})); })()",
      );
      await until(
        () =>
          evaluate(
            "document.documentElement.dataset.theme === " +
              JSON.stringify(theme) +
              " && document.documentElement.style.getPropertyValue('--gyro-ui-scale') === " +
              JSON.stringify(size),
          ),
        "appearance",
      );
      const offsets = await evaluate(
        "[...document.querySelectorAll('.gyro-send-button')].map(button => { const a=button.getBoundingClientRect(), b=button.querySelector('svg').getBoundingClientRect(); return Math.max(Math.abs(a.x+a.width/2-b.x-b.width/2),Math.abs(a.y+a.height/2-b.y-b.height/2)); })",
      );
      assert.ok(
        offsets.every((offset) => offset <= 0.5),
        theme + " / " + size + ": arrow must remain centered",
      );
    }
  }
  for (const pane of ["a", "b", "a"]) {
    await evaluate(
      "[...document.querySelectorAll('button')].find(button => button.textContent === 'Fixture drop " +
        pane.toUpperCase() +
        "').click()",
    );
    await until(
      () =>
        evaluate(
          "document.querySelector('[role=\"status\"]').textContent.startsWith('Attached') && document.querySelector('[role=\"status\"]').textContent.endsWith('Pane " +
            pane.toUpperCase() +
            "')",
        ),
      "drop " + pane,
    );
  }
  assert.equal(
    await evaluate(
      "document.querySelector('[data-fixture-pane=\"a\"]').querySelectorAll('.gyro-composer-attachment').length",
    ),
    2,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-fixture-pane=\"b\"]').querySelectorAll('.gyro-composer-attachment').length",
    ),
    1,
  );
  await evaluate(
    "(() => { const target=document.querySelector('[data-fixture-pane=\"b\"]'), rect=target.getBoundingClientRect(), transfer=new DataTransfer(); for(const width of [64,128]) transfer.items.add(new File(['<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"'+width+'\" height=\"64\"><rect width=\"'+width+'\" height=\"64\" fill=\"blue\"/></svg>'], 'photo.svg', {type:'image/svg+xml',lastModified:width})); const options={bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2}; target.dispatchEvent(new DragEvent('dragover',options)); target.dispatchEvent(new DragEvent('drop',options)); })()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('[data-fixture-pane=\"b\"]').querySelectorAll('.gyro-composer-attachment').length === 3",
      ),
    "distinct same-name files",
  );
  const shot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/private/tmp/gyro-media-reliability-verified.png",
    Buffer.from(shot.data, "base64"),
  );
  console.log(
    "PASS: actual chat components; 6 theme/size arrow checks; repeated URL drops route to the correct pane; same-name file drops retain both images. Storage/provider sends are simulated; Finder gestures are not tested.",
  );
} finally {
  ws?.close();
  browser.kill();
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once("exit", resolve),
  );
  await rm(profile, { recursive: true, force: true });
}
