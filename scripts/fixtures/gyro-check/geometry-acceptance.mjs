// Real Chromium DOM reads using the production page-agent method. This does
// not exercise Tauri, WebKit, native approval, report persistence or cleanup.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function checkGeometryAndCompletion({
  send,
  evaluate,
  root,
  artifacts,
}) {
  let checks = 0;
  const source = await readFile(
    join(root, "apps/desktop/src-tauri/src/session_browser.rs"),
    "utf8",
  );
  const unescape = (s) => s.replaceAll("{{", "{").replaceAll("}}", "}");
  const extract = (start, end) => {
    const a = source.indexOf(start),
      b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `Production browser source boundary: ${start}`);
    return unescape(source.slice(a, b));
  };
  const helpers = [
    extract("  const isVisible =", "  const roleOf ="),
    extract("  const isCredentialField =", "  const assignRef ="),
    extract("  const pageState =", "  const serializeTree ="),
  ].join("\n");
  const method = extract("    checkRead(options)", "    find(options)");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "about:blank" });
  const { frameTree } = await send("Page.getFrameTree");
  await send("Page.setDocumentContent", {
    frameId: frameTree.frame.id,
    html: `<!doctype html><body>
    <main id="ready"><div id="row" style="width:100px;height:59.25px">Row</div>
    <div class="duplicate" style="height:10px">A</div><div class="duplicate" style="height:10px">B</div>
    <div id="hidden" style="display:none;height:59.25px">Hidden</div><input type="password" id="secret"></main>`,
  });
  const install = () =>
    evaluate(
      `(() => {${helpers}\nwindow.readGeometry = ({${method}}).checkRead;})()`,
    );
  await install();
  const read = (selector, kind = "height", readySelector = "#ready") =>
    evaluate(
      `readGeometry(${JSON.stringify({ readySelector, reads: [{ key: "row", selector, kind }] })})`,
    );
  let result = await read("#row");
  assert.equal(result.ok, true);
  assert.equal(result.values.row, 59.25);
  assert.equal(result.viewport.width, 1440);
  assert.equal(result.viewport.height, 1080);
  checks++;
  for (const selector of [
    "#missing",
    "#hidden",
    ".duplicate",
    "#secret",
    "[",
  ]) {
    assert.equal((await read(selector)).ok, false);
    checks++;
  }
  assert.equal((await read("#row", "height", "#missing")).ok, false);
  checks++;
  assert.equal((await read("#row", "evaluate")).ok, false);
  checks++;
  for (const invalid of ["NaN", "Infinity", "-1", "0", "100001"]) {
    await evaluate(
      `document.querySelector('#row').getBoundingClientRect = () => ({width:100,height:${invalid}})`,
    );
    assert.equal((await read("#row")).ok, false);
    checks++;
  }

  const html = await readFile(
    join(root, "mockups/subagents-2026-10-30/conversation.html"),
    "utf8",
  );
  await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  await install();
  const rows = {};
  for (const id of ["parser", "tests", "review"]) {
    result = await read(`[data-agent-row="${id}"]`, "height", "#agent-group");
    assert.equal(result.ok, true);
    assert.ok(result.values.row > 0 && result.values.row < 90);
    rows[id] = result.values.row;
    checks++;
  }
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const reply = () =>
    evaluate(
      "document.querySelector('.latest-assistant .assistant-copy').textContent",
    );
  await click("#add-reply");
  assert.match(await reply(), /still waiting/);
  checks++;
  await click('[data-action="review"][data-agent="tests"]');
  await click('[data-action="decline"][data-agent="tests"]');
  await click("#add-reply");
  assert.match(
    await reply(),
    /stopped or declined.*still in progress; the checks are incomplete/,
  );
  checks++;
  await click('[data-action="stop"][data-agent="review"]');
  await click("#add-reply");
  assert.match(await reply(), /stopped or declined.*checks are incomplete/);
  assert.doesNotMatch(await reply(), /all checks are complete/);
  checks++;
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(artifacts, "stopped-work-corrected.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await click('[data-scenario="finished"]');
  await click("#add-reply");
  assert.match(await reply(), /all checks are complete/);
  checks++;
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.latest-assistant #agent-group').length",
    ),
    1,
  );
  checks++;
  return {
    checks,
    rows,
    viewport: { width: 1440, height: 1080 },
    evidence: "Chromium DOM component and mockup; native WebKit unverified",
  };
}
