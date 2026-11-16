// Real Chromium DOM reads using the production page-agent method. This does
// not exercise Tauri, WebKit, native approval, report persistence or cleanup.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readUiStyles } from "../../ui-style-sources.mjs";

// Render the real component instead of depending on a dated design mockup.
async function productionAgents() {
  const requireUi = createRequire(new URL("../../../packages/ui/package.json", import.meta.url));
  const requireDesktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const { build } = createRequire(requireDesktop.resolve("vite"))("esbuild");
  const compiled = await build({
    stdin: { contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { SubagentList } from "./packages/ui/src/subagents-view.tsx";
      import { subagentActivitySummary } from "./packages/ui/src/subagents.ts";
      export function renderAgents(statuses) {
        const agents = statuses.map((status, i) => ({ agentId:["parser","tests","review"][i], name:["Parser","Tests","Review"][i], status, task:"Verify", providerId:"fixture", readOnly:true, parentSessionId:"fixture", createdAt:"2026-11-16T10:00:00Z", updatedAt:"2026-11-16T10:00:00Z", elapsedMs:1000 }));
        return renderToStaticMarkup(<main id="ready"><div id="agent-group"><SubagentList state={{agents, eventsByAgentId:{}, onSelect:()=>{}, onStop:()=>{}}} /></div><output id="summary">{subagentActivitySummary(agents).label}</output></main>);
      }`, resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader:"tsx" },
    bundle:true, write:false, format:"cjs", platform:"node", jsx:"automatic",
    external:["react", "react-dom", "react-dom/server", "lucide-react"],
    loader:{".png":"dataurl", ".svg":"dataurl", ".css":"empty"},
  });
  const module = { exports:{} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(requireUi, module, module.exports);
  return module.exports.renderAgents;
}

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

  const renderAgents = await productionAgents();
  const styles = readUiStyles();
  const show = async (statuses) => {
    await send("Page.setDocumentContent", { frameId: frameTree.frame.id,
      html: `<!doctype html><html data-theme="dark"><head><style>${styles}</style></head><body>${renderAgents(statuses)}</body></html>` });
    await install();
  };
  await show(["completed", "waiting", "running"]);
  const rows = {};
  for (const name of ["Parser", "Tests", "Review"]) {
    result = await read(`button[aria-label^="Open ${name} working process"]`, "height", "#agent-group");
    assert.equal(result.ok, true);
    assert.ok(result.values.row > 0 && result.values.row < 90);
    rows[name] = result.values.row;
    checks++;
  }
  const summary = () => evaluate("document.querySelector('#summary').textContent");
  assert.match(await summary(), /approval.*working/);
  checks++;
  await show(["completed", "cancelled", "interrupted"]);
  assert.match(await summary(), /attention/);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Open Tests working process · Cancelled\"]') !== null"), true);
  assert.doesNotMatch(await summary(), /3 done|all checks.*complete/i);
  checks += 3;
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifacts, "stopped-work-production.png"), Buffer.from(screenshot.data, "base64"));
  await show(["completed", "completed", "completed"]);
  assert.equal(await summary(), "3 done");
  // Agent completion describes activity; it does not certify independent checks.
  assert.doesNotMatch(await summary(), /checks.*complete|verified/i);
  checks += 2;
  return {
    checks,
    rows,
    viewport: { width: 1440, height: 1080 },
    evidence: "Chromium DOM using the production SubagentList and status summary; native WebKit unverified",
  };
}
