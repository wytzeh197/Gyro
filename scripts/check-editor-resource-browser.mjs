// Isolated Chromium heap/model probe. This is renderer evidence, not a native
// WebKit/RSS claim. Production reducer + editor, generated text, no provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1461";
const output =
  process.env.GYRO_TEST_ARTIFACTS ?? "/private/tmp/gyro-editor-resource";
const baseline = process.argv.includes("--baseline");
const profile = await mkdtemp(join(tmpdir(), "gyro-editor-resource-"));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ??
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=BraveRewards,BraveVPN",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws;
const pending = new Map();
const errors = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(run, label) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const value = await run();
      if (value) return value;
    } catch {}
    await pause(100);
  }
  throw Error(`Timed out: ${label}`);
}
try {
  const page = await until(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (page) => page.type === "page",
      ),
    "browser startup",
  );
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    message.error
      ? job.reject(Error(JSON.stringify(message.error)))
      : job.resolve(message.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP timed out: ${method}`));
      }, 120_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("HeapProfiler.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", {
    url: `${origin}/editor-resource-fixture.html`,
  });
  await until(
    () => evaluate("!!window.__editorResourceFixture"),
    "fixture mount",
  );
  async function preview(index) {
    const uri = await evaluate(
      `window.__editorResourceFixture.preview(${index})`,
    );
    await until(
      () =>
        evaluate(
          `window.__editorResourceFixture.monaco.editor.getEditors().some(editor => editor.getModel()?.uri.toString() === ${JSON.stringify(uri)})`,
        ),
      `preview ${index}`,
    );
    // Let passive model-change/disposal tasks finish, without requiring a
    // particular machine's editor paint time.
    await evaluate("new Promise(resolve => setTimeout(resolve, 25))");
  }
  async function measurement(label) {
    await call("HeapProfiler.collectGarbage");
    return {
      label,
      ...(await evaluate("window.__editorResourceFixture.stats()")),
      heap: await call("Runtime.getHeapUsage"),
      dom: await call("Memory.getDOMCounters"),
    };
  }
  await preview(-1);
  await evaluate("window.__editorResourceFixture.close()");
  await until(
    () => evaluate("window.__editorResourceFixture.stats().editorCount === 0"),
    "warm editor unmount",
  );
  const samples = [await measurement("warm empty")];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let index = 0; index < 24; index++) await preview(cycle * 24 + index);
    const sample = await measurement(`after ${(cycle + 1) * 24} previews`);
    samples.push(sample);
    if (!baseline) {
      assert.equal(sample.tabs, 1);
      assert.equal(
        sample.buffers,
        1,
        "replaced clean previews must release file buffers",
      );
      assert.equal(
        sample.models,
        1,
        "replaced clean previews must release Monaco text models",
      );
    }
  }
  await evaluate("window.__editorResourceFixture.close()");
  await until(
    () => evaluate("window.__editorResourceFixture.stats().editorCount === 0"),
    "editor close",
  );
  const closed = await measurement("closed final preview");
  samples.push(closed);
  if (!baseline) {
    assert.equal(closed.buffers, 0);
    assert.equal(closed.models, 0);
    assert.equal(closed.modelCharacters, 0);
    // User-visible quality: pinning/editing retains the model and its undo
    // stack; replacing a shared preview must keep the other split intact.
    await preview(1000);
    await evaluate(`(() => {
      const f = window.__editorResourceFixture; f.pin();
      const editor = f.monaco.editor.getEditors()[0];
      editor.pushUndoStop();
      editor.executeEdits('fixture', [{range: new f.monaco.Range(1, 1, 1, 1), text: 'KEEP_UNSAVED\\n'}]);
      editor.pushUndoStop();
    })()`);
    await until(
      () =>
        evaluate(
          "window.__editorResourceFixture.activeContent()?.startsWith('KEEP_UNSAVED')",
        ),
      "dirty buffer",
    );
    await preview(1001);
    assert.equal(
      await evaluate("window.__editorResourceFixture.stats().models"),
      2,
    );
    await evaluate("window.__editorResourceFixture.select(1000)");
    await until(
      () =>
        evaluate(
          "window.__editorResourceFixture.monaco.editor.getEditors()[0]?.getValue().startsWith('KEEP_UNSAVED')",
        ),
      "pinned dirty model return",
    );
    await evaluate(
      "window.__editorResourceFixture.monaco.editor.getEditors()[0].trigger('fixture', 'undo', null)",
    );
    await until(
      () =>
        evaluate(
          "window.__editorResourceFixture.activeContent()?.startsWith('File 1000,')",
        ),
      "preserved undo stack",
    );
    await evaluate("window.__editorResourceFixture.clear()");
    await until(
      () => evaluate("window.__editorResourceFixture.stats().models === 0"),
      "pinned cleanup",
    );
    await preview(2000);
    await evaluate("window.__editorResourceFixture.split()");
    await until(
      () =>
        evaluate("window.__editorResourceFixture.stats().editorCount === 2"),
      "shared split mount",
    );
    await preview(2001);
    assert.equal(
      await evaluate("window.__editorResourceFixture.stats().models"),
      2,
    );
    assert.equal(
      await evaluate(
        "window.__editorResourceFixture.monaco.editor.getEditors().filter(editor => editor.getValue().startsWith('File 2000,')).length",
      ),
      1,
    );
    await evaluate(
      "window.__editorResourceFixture.closeGroup(window.__editorResourceFixture.groups()[1].id)",
    );
    await until(
      () => evaluate("window.__editorResourceFixture.stats().models === 1"),
      "last owner only retirement",
    );
    await evaluate("window.__editorResourceFixture.clear()");
    await until(
      () => evaluate("window.__editorResourceFixture.stats().models === 0"),
      "split cleanup",
    );
    // Closing a clean preview frees text, while its lightweight pane-local
    // cursor/scroll memento keeps navigation behavior unchanged on reopening.
    await preview(3000);
    const savedView = await evaluate(`(() => {
      const editor = window.__editorResourceFixture.monaco.editor.getEditors()[0];
      editor.setPosition({lineNumber: 100, column: 15});
      editor.setScrollTop(1000);
      return {position: editor.getPosition(), scrollTop: editor.getScrollTop()};
    })()`);
    await preview(3001);
    await preview(3000);
    const restoredView = await evaluate(`(() => {
      const editor = window.__editorResourceFixture.monaco.editor.getEditors()[0];
      return {position: editor.getPosition(), scrollTop: editor.getScrollTop()};
    })()`);
    assert.deepEqual(restoredView.position, savedView.position);
    assert.ok(Math.abs(restoredView.scrollTop - savedView.scrollTop) <= 2);
    await evaluate("window.__editorResourceFixture.clear()");
    await until(
      () => evaluate("window.__editorResourceFixture.stats().models === 0"),
      "view-state cleanup",
    );
    await evaluate("window.__editorResourceFixtureReloadMarker = true");
    await call("Page.reload");
    await until(
      () =>
        evaluate(
          "!!window.__editorResourceFixture && !window.__editorResourceFixtureReloadMarker",
        ),
      "cold remount",
    );
    await evaluate(
      "(async () => { for (let i=0; i<100; i++) { window.__editorResourceFixture.preview(5000+i); await new Promise(resolve => setTimeout(resolve, 5)); } })()",
    );
    await until(
      () =>
        evaluate(
          "window.__editorResourceFixture.monaco.editor.getEditors()[0]?.getModel()?.uri.path.endsWith('preview-5099.txt')",
        ),
      "rapid preview during lazy mount",
    );
    await evaluate("new Promise(resolve => setTimeout(resolve, 25))");
    assert.equal(
      await evaluate("window.__editorResourceFixture.stats().models"),
      1,
    );
    await evaluate("window.__editorResourceFixture.close()");
    await until(
      () => evaluate("window.__editorResourceFixture.stats().models === 0"),
      "cold preview cleanup",
    );
  }
  const unexpected = errors.filter(
    (error) =>
      !(
        error.exception?.description?.startsWith("Canceled: Canceled") &&
        (error.exception.description.includes("at Delayer.cancel") ||
          error.exception.description.includes("at Delayer.dispose") ||
          (error.stackTrace?.callFrames?.[0]?.functionName === "cancel" &&
            error.stackTrace?.callFrames?.[1]?.functionName === "dispose"))
      ),
  );
  if (unexpected.length) console.error(JSON.stringify(unexpected, null, 2));
  assert.equal(unexpected.length, 0, "no unexpected renderer errors");
  await mkdir(output, { recursive: true });
  const result = {
    schema: "gyro.editor-resource-lifecycle.v1",
    phase: baseline ? "before" : "after",
    evidence:
      "Actual production reducer and Monaco pane in isolated Chromium; generated 1024-line text files; renderer heap only, not native WebKit footprint",
    browserVersion: await call("Browser.getVersion"),
    previews: 72,
    qualityChecks: baseline
      ? []
      : [
          "pinned unsaved text and undo",
          "shared split ownership and final close",
          "closed-preview cursor and scroll on reopen",
          "100 rapid previews during lazy mount",
        ],
    samples,
    errors,
  };
  await writeFile(
    join(output, `${result.phase}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        phase: result.phase,
        samples: samples.map(({ heap, dom, ...s }) => ({
          ...s,
          heapUsedMiB: heap.usedSize / 2 ** 20,
        })),
        output,
      },
      null,
      2,
    ),
  );
} finally {
  for (const job of pending.values()) clearTimeout(job.timer);
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise((resolve) =>
    browser.exitCode !== null || browser.signalCode !== null
      ? resolve()
      : browser.once("exit", resolve),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
