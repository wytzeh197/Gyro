import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This verifies the production renderer against explicitly mocked LSP responses.
// Native LSP correctness is covered separately by the Workspace native checks.
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420";
const artifactDirectory =
  process.env.GYRO_TEST_ARTIFACTS ??
  "/private/tmp/gyro-workspace-navigation-browser";
await mkdir(artifactDirectory, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-workspace-browser-"));
const port = 9478;
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
let failureSnapshot;
const errors = [];
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await pause();
  }
  if (failureSnapshot) console.error("Browser state:", await failureSnapshot());
  throw Error(`Timed out: ${description}`);
}
try {
  const page = await until(
    async () => {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return pages.find((page) => page.type === "page");
    },
    "browser startup",
  );
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      message.error
        ? callback.reject(message.error)
        : callback.resolve(message.result);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ id: requestId, method, params }));
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
  const screenshot = async (name) => {
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(join(artifactDirectory, name), Buffer.from(data, "base64"));
  };
  failureSnapshot = async () => {
    await screenshot("failure.png");
    return evaluate(
      `({dialog:document.querySelector('dialog')?.textContent,active:document.activeElement?.tagName,models:window.__workspaceFixture.monaco.editor.getModels().map(model=>model.uri.toString()),draft:{name:window.__workspaceFixture.getState().draft?.name,busy:window.__workspaceFixture.getState().draft?.busy,error:window.__workspaceFixture.getState().draft?.error},requests:window.__workspaceFixture.getState().requests,diffCount:document.querySelectorAll('dialog .monaco-diff-editor').length})`,
    );
  };
  const click = (label) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(label)}).click()`,
    );
  const key = async (name, virtual, modifiers = 0) => {
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: name,
      code: name,
      windowsVirtualKeyCode: virtual,
      modifiers,
      ...(name === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: name,
      code: name,
      windowsVirtualKeyCode: virtual,
      modifiers,
    });
  };
  const mainEditor = `window.__workspaceFixture.monaco.editor.getEditors().find(editor => editor.getDomNode()?.closest('.workspace-fixture-main'))`;
  const splitEditor = `window.__workspaceFixture.monaco.editor.getEditors().find(editor => editor.getDomNode()?.closest('.workspace-fixture-split'))`;
  const renameMenuLabel = `(()=>{const roots=[document,...[...document.querySelectorAll('.shadow-root-host')].map(host=>host.shadowRoot).filter(Boolean)];return roots.flatMap(root=>[...root.querySelectorAll('.action-label')]).find(item=>item.textContent==='Rename symbol');})()`;
  const renameInputReady = `(()=>{const input=document.querySelector('dialog[open] input');return !!input && !input.disabled && document.activeElement===input;})()`;
  const previewRendered = `[...document.querySelectorAll('dialog .monaco-diff-editor .view-lines')].some(lines=>lines.textContent.includes('message') && lines.textContent.includes('welcome'))`;
  const state = `window.__workspaceFixture.getState()`;
  const atTarget = () =>
    evaluate(`${state}.main === window.__workspaceFixture.targetPath`);
  const openMain = async () => {
    await click("Open main.ts");
    await until(
      () =>
        evaluate(
          `${state}.main === window.__workspaceFixture.mainPath && ${mainEditor}.getModel().uri.path === window.__workspaceFixture.mainPath`,
        ),
      "main model reattachment",
    );
  };
  const symbol = () =>
    evaluate(
      `(()=>{const editor=${mainEditor}; editor.setPosition({lineNumber:3,column:18}); editor.setScrollTop(0); editor.focus();})()`,
    );
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", {
    url: origin + "/workspace-navigation-fixture.html",
  });
  await until(
    () =>
      evaluate(
        `!!window.__workspaceFixture && !!${mainEditor} && ${mainEditor}.getModel()?.getLanguageId() === 'typescript'`,
      ),
    "production Monaco + syntax",
  );
  assert.equal(
    await evaluate(
      `window.__workspaceFixture.monaco.editor.getModels().some(model => model.uri.path === window.__workspaceFixture.targetPath)`,
    ),
    false,
    "definition target starts unopened",
  );
  await click("Split same file");
  await until(() => evaluate(`!!${splitEditor}`), "split Monaco mount");
  await evaluate(
    `(()=>{const editor=${splitEditor}; editor.setPosition({lineNumber:12,column:6}); editor.setScrollTop(130);})()`,
  );
  const splitBefore = await evaluate(
    `({position:${splitEditor}.getPosition(),scroll:${splitEditor}.getScrollTop()})`,
  );
  await symbol();
  await key("F12", 123);
  await until(atTarget, "F12 opens unopened target");
  await until(
    () =>
      evaluate(
        `${mainEditor}.getPosition()?.column === 17 && ${mainEditor}.getModel().uri.path === window.__workspaceFixture.targetPath`,
      ),
    "LocationLink target selection range",
  );
  assert.deepEqual(
    await evaluate(
      `({position:${splitEditor}.getPosition(),scroll:${splitEditor}.getScrollTop()})`,
    ),
    splitBefore,
    "split retains independent cursor and viewport",
  );
  await openMain();
  await evaluate(
    `(()=>{const editor=${mainEditor}; editor.setPosition({lineNumber:38,column:4}); editor.setScrollTop(520); editor.focus();})()`,
  );
  const before = await evaluate(
    `({position:${mainEditor}.getPosition(),scroll:${mainEditor}.getScrollTop()})`,
  );
  await key("F12", 123);
  await until(atTarget, "second definition jump");
  await openMain();
  assert.deepEqual(
    await evaluate(
      `({position:${mainEditor}.getPosition(),scroll:${mainEditor}.getScrollTop()})`,
    ),
    before,
    "returning restores cursor and scroll",
  );
  await symbol();
  const point = await evaluate(
    `(()=>{const editor=${mainEditor}; const p=editor.getScrolledVisiblePosition({lineNumber:3,column:18}); const b=editor.getDomNode().getBoundingClientRect(); return {x:b.x+p.left+3,y:b.y+p.top+p.height/2};})()`,
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    modifiers: 4,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...point,
    modifiers: 4,
  });
  await pause(400);
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
    modifiers: 4,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
    modifiers: 4,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
  });
  await until(atTarget, "Cmd-click navigation");
  await openMain();
  await symbol();
  await key("F12", 123, 8);
  await until(
    () =>
      evaluate(
        `!!document.querySelector('.reference-zone-widget') && ${state}.requests.some(request => request.method === 'textDocument/references')`,
      ),
    "Shift-F12 reference widget",
  );
  console.log(
    "Reference rows:",
    await evaluate(
      `[...document.querySelectorAll('.reference-zone-widget .monaco-list-row')].map(row => ({text:row.textContent,label:row.getAttribute('aria-label')}))`,
    ),
  );
  await screenshot("references-dark.png");
  await evaluate(
    `[...document.querySelectorAll('.reference-zone-widget .monaco-list-row')].find(row => row.textContent.includes('greeting #é%'))?.querySelector('.monaco-tl-twistie')?.click()`,
  );
  await until(
    () =>
      evaluate(
        `[...document.querySelectorAll('.reference-zone-widget .monaco-list-row')].some(row => row.getAttribute('aria-label')?.includes('in greeting #é%.ts on line'))`,
      ),
    "expand target reference",
  );
  const referencePoint = await evaluate(
    `(()=>{const row=[...document.querySelectorAll('.reference-zone-widget .monaco-list-row')].find(row=>row.getAttribute('aria-label')?.includes('in greeting #é%.ts on line')); const rect=row.getBoundingClientRect();return {x:rect.x+80,y:rect.y+rect.height/2};})()`,
  );
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...referencePoint,
    button: "left",
    clickCount: 2,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...referencePoint,
    button: "left",
    clickCount: 2,
  });
  await until(atTarget, "selected reference opens target");
  await click("Reset fixture");
  await until(
    () =>
      evaluate(
        `!!window.__workspaceFixture && !!${mainEditor} && ${mainEditor}.getModel()?.getLanguageId()==='typescript' && !${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath]`,
      ),
    "fresh dirty/unopened rename scenario",
  );
  await click("Split same file");
  await until(() => evaluate(`!!${splitEditor}`), "new split mount");
  await symbol();
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "right",
    clickCount: 1,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "right",
    clickCount: 1,
  });
  await until(
    () => evaluate(`!!${renameMenuLabel}`),
    "Rename symbol context action",
  );
  const renameMenuPoint = await evaluate(
    `(()=>{const item=${renameMenuLabel};const rect=item.getBoundingClientRect();return {x:rect.x+30,y:rect.y+rect.height/2};})()`,
  );
  await pause(150);
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...renameMenuPoint,
    button: "left",
    clickCount: 1,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...renameMenuPoint,
    button: "left",
    clickCount: 1,
  });
  await until(() => evaluate(renameInputReady), "context-menu rename callback");
  await key("Escape", 27);
  await until(
    () => evaluate(`!document.querySelector('dialog')`),
    "cancel context rename",
  );
  await symbol();
  await key("F2", 113);
  await until(() => evaluate(renameInputReady), "F2 production rename input");
  await call("Input.insertText", { text: "welcome" });
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!!document.querySelector('dialog.is-preview') && document.activeElement.textContent === 'Apply rename' && document.querySelectorAll('dialog .monaco-diff-editor').length === 1`,
      ),
    "rename preview and keyboard focus",
  );
  await until(() => evaluate(previewRendered), "dark preview rendered");
  await screenshot("rename-dark.png");
  await key("Escape", 27);
  await until(
    () => evaluate(`!document.querySelector('dialog')`),
    "Escape cancels preview",
  );
  await until(
    () => evaluate(`!window.__workspaceFixture.monaco.editor.getModels().some(model=>model.uri.scheme==='inmemory')`),
    "canceled preview releases its owned diff models",
  );
  assert.equal(
    await evaluate(
      `${state}.files[window.__workspaceFixture.mainPath].includes('greet(')`,
    ),
    true,
    "cancel preserves fixture buffers",
  );
  assert.equal(
    await evaluate(
      `!${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath]`,
    ),
    true,
    "cancel releases clean temporary target buffer",
  );
  for (const cancelAction of ["Escape", "Cancel"]) {
    await evaluate(`window.__workspaceFixture.delayFinalRename()`);
    await symbol();
    await key("F2", 113);
    await until(() => evaluate(renameInputReady), "delayed rename input ready");
    await call("Input.insertText", { text: "welcome" });
    await key("Enter", 13);
    await until(
      () =>
        evaluate(
          `${state}.pendingRename && ${state}.draft?.busy && !!${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath] && document.activeElement?.textContent==='Cancel'`,
        ),
      "final rename response delayed after target hydration",
    );
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('dialog button')].find(button=>button.textContent==='Cancel').disabled`,
      ),
      false,
      "Cancel remains enabled during request",
    );
    if (cancelAction === "Escape") await key("Escape", 27);
    else await click("Cancel");
    await until(
      () =>
        evaluate(
          `!document.querySelector('dialog') && !${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath]`,
        ),
      `${cancelAction} cancels pending rename and cleans temporary file`,
    );
    await evaluate(`window.__workspaceFixture.releaseDelayedRename()`);
    await pause(200);
    assert.equal(
      await evaluate(
        `!${state}.draft && !${state}.canUndo && ${state}.files[window.__workspaceFixture.mainPath].includes('greet(')`,
      ),
      true,
      "late rename response cannot revive canceled draft or apply edits",
    );
  }
  await evaluate(`window.__workspaceFixture.foreignDirtyTargetOnce()`);
  await until(
    () =>
      evaluate(
        `!!${state}.workbench.ide.buffers[window.__workspaceFixture.foreignPath]`,
      ),
    "foreign dirty buffer installed",
  );
  const foreignBefore = await evaluate(
    `${state}.files[window.__workspaceFixture.foreignPath]`,
  );
  await symbol();
  await key("F2", 113);
  await until(() => evaluate(renameInputReady), "foreign-root rename input");
  await call("Input.insertText", { text: "welcome" });
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `${state}.draft?.error?.includes('across workspace folders') && !${state}.draft.busy`,
      ),
    "version-null foreign-root edit rejected",
  );
  assert.equal(
    await evaluate(`${state}.files[window.__workspaceFixture.foreignPath]`),
    foreignBefore,
    "foreign-root dirty content untouched",
  );
  assert.equal(
    await evaluate(
      `!${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath] && ${state}.files[window.__workspaceFixture.mainPath].includes('greet(') && !${state}.canUndo`,
    ),
    true,
    "cross-root rejection performs no target hydration or source edit",
  );
  await screenshot("rename-foreign-root-rejected.png");
  await key("Escape", 27);
  await until(
    () => evaluate(`!document.querySelector('dialog')`),
    "cancel foreign-root error",
  );
  await evaluate(`window.__workspaceFixture.openForeign()`);
  await until(
    () =>
      evaluate(
        `${mainEditor}.getModel().uri.path===window.__workspaceFixture.foreignPath`,
      ),
    "second-root source attached",
  );
  await evaluate(
    `(()=>{const editor=${mainEditor};editor.setPosition({lineNumber:2,column:18});editor.focus();})()`,
  );
  await key("F2", 113);
  await until(
    () => evaluate(renameInputReady),
    "local second-root rename input",
  );
  await call("Input.insertText", { text: "otherWelcome" });
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!!document.querySelector('dialog.is-preview') && document.activeElement.textContent==='Apply rename'`,
      ),
    "local second-root rename preview",
  );
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!document.querySelector('dialog') && ${state}.files[window.__workspaceFixture.foreignPath].includes('function otherWelcome(')`,
      ),
    "local second-root rename succeeds",
  );
  await click("Undo rename");
  await until(
    () =>
      evaluate(
        `${state}.files[window.__workspaceFixture.foreignPath]===${JSON.stringify(foreignBefore)} && !${state}.canUndo`,
      ),
    "local second-root rename undo preserves existing dirty text",
  );
  await evaluate(`window.__workspaceFixture.clearForeignDraft()`);
  await openMain();
  // A target disk race during the final LSP response rejects the complete plan.
  await evaluate(`window.__workspaceFixture.raceTargetDuringRename()`);
  await symbol();
  await key("F2", 113);
  await until(() => evaluate(renameInputReady), "disk-race rename ready");
  await call("Input.insertText", { text: "welcome" });
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `${state}.draft?.error?.includes('changed on disk') && !${state}.draft.busy`,
      ),
    "disk race during request rejects preview",
  );
  assert.equal(
    await evaluate(
      `${state}.files[window.__workspaceFixture.mainPath].includes('greet(') && !${state}.canUndo`,
    ),
    true,
    "disk request race preserves dirty source",
  );
  assert.equal(
    await evaluate(
      `!${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath]`,
    ),
    true,
    "failed preview releases clean temporary target buffer",
  );
  await screenshot("rename-disk-request-race.png");
  await evaluate(`window.__workspaceFixture.restoreTargetDisk()`);
  await key("Escape", 27);
  await until(
    () => evaluate(`!document.querySelector('dialog')`),
    "cancel disk request race",
  );
  await symbol();
  await key("F2", 113);
  await until(() => evaluate(renameInputReady), "disk-preview rename ready");
  await call("Input.insertText", { text: "welcome" });
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!!document.querySelector('dialog.is-preview') && document.activeElement.textContent==='Apply rename'`,
      ),
    "disk preview ready",
  );
  await evaluate(`window.__workspaceFixture.mutateTargetDisk()`);
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `${state}.draft?.error?.includes('changed on disk') && !${state}.draft.busy`,
      ),
    "disk change after preview rejects apply",
  );
  assert.equal(
    await evaluate(
      `${state}.files[window.__workspaceFixture.mainPath].includes('greet(') && !${state}.canUndo`,
    ),
    true,
    "disk apply race leaves source unchanged",
  );
  await screenshot("rename-disk-preview-race.png");
  await evaluate(`window.__workspaceFixture.restoreTargetDisk()`);
  await key("Escape", 27);
  await until(
    () => evaluate(`!document.querySelector('dialog')`),
    "cancel disk preview race",
  );
  await symbol();
  await key("F2", 113);
  await until(() => evaluate(renameInputReady), "stale-preview rename ready");
  await call("Input.insertText", { text: "welcome" });
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!!document.querySelector('dialog.is-preview') && document.activeElement.textContent==='Apply rename'`,
      ),
    "stale preview ready",
  );
  await evaluate(
    `(()=>{const editor=${mainEditor}; const model=editor.getModel(); const line=model.getLineCount();const column=model.getLineMaxColumn(line);editor.executeEdits('fixture-newer-edit',[{range:{startLineNumber:line,startColumn:column,endLineNumber:line,endColumn:column},text:'\\n// Newer fixture edit',forceMoveMarkers:true}]);})()`,
  );
  await until(
    () =>
      evaluate(
        `${state}.files[window.__workspaceFixture.mainPath].includes('// Newer fixture edit')`,
      ),
    "newer buffer edit reaches host",
  );
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `${state}.draft?.error?.includes('The source changed') && !${state}.draft.busy`,
      ),
    "stale preview rejects all changes",
  );
  assert.equal(
    await evaluate(
      `(!${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath] || ${state}.files[window.__workspaceFixture.targetPath].includes('function greet(')) && ${state}.files[window.__workspaceFixture.mainPath].includes('greet(')`,
    ),
    true,
    "failed transaction leaves unopened target untouched",
  );
  await screenshot("rename-stale-preview.png");
  await key("Escape", 27);
  await until(
    () => evaluate(`!document.querySelector('dialog')`),
    "cancel stale preview",
  );
  await click("Switch to light");
  await symbol();
  await key("F2", 113);
  await until(() => evaluate(renameInputReady), "light rename input");
  await call("Input.insertText", { text: "welcome" });
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!!document.querySelector('dialog.is-preview') && document.activeElement.textContent === 'Apply rename'`,
      ),
    "light preview",
  );
  await until(() => evaluate(previewRendered), "light preview rendered");
  await screenshot("rename-light.png");
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!document.querySelector('dialog') && ${state}.files[window.__workspaceFixture.mainPath].includes('welcome(')`,
      ),
    "Enter applies preview",
  );
  assert.equal(
    await evaluate(`${splitEditor}.getValue().includes('welcome(')`),
    true,
    "shared model update reaches split",
  );
  assert.equal(
    await evaluate(
      `${state}.files[window.__workspaceFixture.targetPath].includes('function welcome(')`,
    ),
    true,
    "mock rename applies both preview files",
  );
  assert.equal(
    await evaluate(
      `${state}.files[window.__workspaceFixture.mainPath].includes('// Unsaved fixture note')`,
    ),
    true,
    "rename preserves pre-existing dirty text",
  );
  assert.equal(
    await evaluate(
      `JSON.parse(localStorage.getItem('gyro.workspace-edit-recovery.v1')).buffers[window.__workspaceFixture.targetPath].content.includes('welcome(')`,
    ),
    true,
    "apply journals unopened target before reload",
  );
  await click("Undo rename");
  await until(
    () =>
      evaluate(
        `${state}.files[window.__workspaceFixture.mainPath].includes('greet(') && !${state}.canUndo`,
      ),
    "transaction undo",
  );
  assert.equal(
    await evaluate(
      `${state}.files[window.__workspaceFixture.mainPath].includes('// Unsaved fixture note')`,
    ),
    true,
    "undo retains earlier dirty text",
  );
  assert.equal(
    await evaluate(
      `${state}.workbench.ide.buffers[window.__workspaceFixture.mainPath].status`,
    ),
    "dirty",
    "undo restores original dirty status",
  );
  assert.equal(
    await evaluate(
      `!${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath] || ${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath].status === 'ready'`,
    ),
    true,
    "undo restores or releases unopened target",
  );
  await symbol();
  await key("F2", 113);
  await until(() => evaluate(renameInputReady), "second rename ready");
  await call("Input.insertText", { text: "welcome" });
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!!document.querySelector('dialog.is-preview') && document.activeElement.textContent==='Apply rename'`,
      ),
    "second rename preview",
  );
  await key("Enter", 13);
  await until(
    () =>
      evaluate(
        `!document.querySelector('dialog') && ${state}.files[window.__workspaceFixture.mainPath].includes('welcome(')`,
      ),
    "second rename applied",
  );
  await call("Page.reload");
  await until(
    () =>
      evaluate(
        `!!window.__workspaceFixture && !!${mainEditor} && ${state}.files[window.__workspaceFixture.mainPath].includes('welcome(') && ${state}.files[window.__workspaceFixture.targetPath]?.includes('welcome(')`,
      ),
    "recovery journal survives browser reload",
  );
  assert.equal(
    await evaluate(
      `${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath].status`,
    ),
    "dirty",
    "hidden target restored dirty",
  );
  assert.equal(
    await evaluate(
      `${state}.files[window.__workspaceFixture.mainPath].includes('// Unsaved fixture note')`,
    ),
    true,
    "recovery retains earlier dirty text",
  );
  await screenshot("workspace-recovered-dark.png");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 860,
    height: 620,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause(300);
  const shell = await evaluate(
    `(()=>{const primary=document.querySelector('.gyro-workspace-primary'),bar=primary.querySelector('.gyro-workspace-edit-bar'),editors=primary.querySelector('.workspace-fixture-editors');const p=primary.getBoundingClientRect(),b=bar.getBoundingClientRect(),e=editors.getBoundingClientRect();return {rows:getComputedStyle(primary).gridTemplateRows,primary:p.height,bar:b.height,editor:e.height,aligned:Math.abs(b.bottom-e.top)<1,overflow:primary.scrollWidth>primary.clientWidth,layoutHeight:${mainEditor}.getLayoutInfo().height,layoutWidth:${mainEditor}.getLayoutInfo().width,primaryWidth:p.width,editorWidth:e.width,clientWidth:primary.clientWidth,scrollWidth:primary.scrollWidth};})()`,
  );
  await screenshot("workspace-recovered-860x620.png");
  console.log("860×620 shell geometry:", shell);
  assert.equal(
    shell.aligned,
    true,
    "production shell grid places editor beneath edit bar",
  );
  assert.equal(shell.overflow, false, "860px shell has no horizontal overflow");
  assert.ok(
    shell.layoutWidth <= shell.editorWidth + 1,
    "Monaco resizes within the 860px editor container",
  );
  assert.ok(
    shell.editor > 300 && shell.bar < 80 && shell.layoutHeight > 250,
    "edit bar leaves usable editor height at 860×620",
  );
  await screenshot("workspace-recovered-860x620.png");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause(200);
  await evaluate(`window.__workspaceFixture.failTargetSaveOnce()`);
  await click("Save all");
  await until(
    () =>
      evaluate(
        `!!document.querySelector('.gyro-workspace-edit-bar [role="alert"]') && ${state}.workbench.ide.buffers[window.__workspaceFixture.mainPath].content===${state}.workbench.ide.buffers[window.__workspaceFixture.mainPath].savedContent && ${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath].content!==${state}.workbench.ide.buffers[window.__workspaceFixture.targetPath].savedContent`,
      ),
    "partial Save all preserves failed target draft",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.gyro-workspace-edit-bar [role="alert"]').textContent.includes(window.__workspaceFixture.targetPath)`,
    ),
    true,
    "Save all error identifies failed target",
  );
  await until(
    () =>
      evaluate(
        `JSON.parse(localStorage.getItem('gyro.workspace-edit-recovery.v1')).buffers[window.__workspaceFixture.targetPath]?.content.includes('welcome(') && !JSON.parse(localStorage.getItem('gyro.workspace-edit-recovery.v1')).buffers[window.__workspaceFixture.mainPath]`,
      ),
    "partial save keeps only failed target in recovery journal",
  );
  await screenshot("workspace-partial-save-dark.png");
  await click("Save all");
  await until(
    () =>
      evaluate(
        `Object.values(${state}.workbench.ide.buffers).every(buffer=>buffer.content===buffer.savedContent) && Object.keys(JSON.parse(localStorage.getItem('gyro.workspace-edit-recovery.v1')).buffers).length===0`,
      ),
    "Save all clears recovery drafts",
  );
  assert.equal(
    await evaluate(
      `${state}.disk[window.__workspaceFixture.targetPath].includes('function welcome(')`,
    ),
    true,
    "Save all writes mock disk target",
  );
  await call("Page.reload");
  await until(
    () =>
      evaluate(
        `!!window.__workspaceFixture && !!${mainEditor} && ${state}.workbench.ide.buffers[window.__workspaceFixture.mainPath].content===${state}.workbench.ide.buffers[window.__workspaceFixture.mainPath].savedContent`,
      ),
    "saved text remains clean after reload",
  );
  await screenshot("workspace-saved-dark.png");
  await writeFile(
    join(artifactDirectory, "browser-errors.json"),
    JSON.stringify(errors, null, 2),
  );
  // Monaco's Delayer rejects with its standard Canceled error when built-in
  // reference/editor contributions are disposed during navigation. Keep these
  // in the saved log, but fail on every other browser exception.
  const cancellations = errors.filter(
    (error) =>
      error.exception?.description?.startsWith("Canceled: Canceled") &&
      (error.exception.description.includes("at Delayer.cancel") ||
        (error.stackTrace?.callFrames?.[0]?.functionName === "cancel" &&
          ["dispose", "restore"].includes(
            error.stackTrace?.callFrames?.[1]?.functionName,
          ))),
  );
  const unexpected = errors.filter((error) => !cancellations.includes(error));
  assert.equal(unexpected.length, 0, "no unexpected browser exceptions");
  console.log(
    `Workspace renderer browser checks passed (mock LSP + disk; ${cancellations.length} Monaco Delayer disposal cancellations logged): F12, Cmd-click, references, split cursor/scroll, F2, keyboard preview/cancel/apply, dirty/unopened transaction, undo, Save all and recovery reload. Screenshots: ${artifactDirectory}`,
  );
} catch (error) {
  console.error("Workspace browser failure:", error);
  throw error;
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once("exit", resolve),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
