import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1427";
const artifacts =
  process.env.GYRO_TEST_ARTIFACTS ?? "/private/tmp/gyro-chat-drag-browser";
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-chat-drag-browser-"));
const port = Number(process.env.GYRO_TEST_BROWSER_PORT ?? "9487");
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
let evaluate;
let screenshot;
const errors = [];
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause();
  }
  throw Error(`Timed out: ${description}`);
}
try {
  let page;
  await until(async () => {
    try {
      page = (
        await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      ).find((page) => page.type === "page");
      return page;
    } catch {
      return false;
    }
  }, "browser startup");
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
  evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  screenshot = async (name) => {
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(join(artifacts, name), Buffer.from(data, "base64"));
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: `${origin}/chat-drag-preview.html` });
  await until(
    () =>
      evaluate(
        "Boolean(window.__chatDragFixture && document.querySelector('.gyro-session-row'))",
      ),
    "fixture ready",
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).filter(button=>button.textContent.trim()==='more').forEach(button=>button.click())",
  );
  await until(
    () =>
      evaluate(
        "Array.from(document.querySelectorAll('.gyro-session-row')).some(row=>row.textContent.includes('Fixture chat Epsilon'))",
      ),
    "sidebar chats expanded",
  );
  await evaluate(`window.__dragTest = {
    start(id, pane=false) {
      const source = pane ? document.querySelector('[data-chat-pane-drag="'+id+'"]') :
        Array.from(document.querySelectorAll('.gyro-session-row')).find(row=>row.textContent.includes('Fixture chat '+id[0].toUpperCase()+id.slice(1)));
      if (!source) throw Error('Missing source '+id);
      this.source=source;
      this.transfer=new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:this.transfer}));
    },
    event(type,x=.5,y=.5,hidden=false,outside=false) {
      const grid=document.querySelector('.gyro-chat-grid');
      const rect=grid.getBoundingClientRect();
      const target=outside ? document.querySelector('.gyro-sidebar-thread-main') : grid;
      const event=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:hidden?new DataTransfer():this.transfer,
        clientX:rect.left+rect.width*x,clientY:rect.top+rect.height*y});
      target.dispatchEvent(event);
      return {blocked:event.defaultPrevented,effect:event.dataTransfer.dropEffect};
    },
    end() {this.source?.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:this.transfer}));},
    fresh(type, value) {
      const transfer=new DataTransfer();transfer.setData(type,value);
      const grid=document.querySelector('.gyro-chat-grid');const rect=grid.getBoundingClientRect();
      const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+rect.width*.5,clientY:rect.top+rect.height*.5});
      grid.dispatchEvent(event);return event.defaultPrevented;
    }
  }`);
  const state = () => evaluate("window.__chatDragFixture.getState()");
  const order = async () => {
    const { grid } = await state();
    return (
      grid.layouts[grid.activeProjectKey]?.slots
        .filter(Boolean)
        .map((pane) => pane.sessionId ?? pane.draftKey) ?? []
    );
  };
  const assertOrder = async (expected) => {
    await until(
      async () => JSON.stringify(await order()) === JSON.stringify(expected),
      `chat order ${expected}`,
    );
  };
  const noFeedback = async () =>
    until(
      () =>
        evaluate(
          "!document.querySelector('.gyro-chat-grid.is-dragging,.gyro-session-row.is-dragging,.gyro-chat-grid-drop-overlay,.gyro-chat-pointer-dragging')",
        ),
      "drag feedback clears",
    );
  const setLayout = async (
    ids,
    arrangement = "columns",
    maximize,
    focused = ids[0],
  ) => {
    const panes = ids.map((id) =>
      id == null
        ? null
        : {
            paneId: id,
            kind: "session",
            sessionId: id,
            workspacePath: "/fixture/Gyro",
          },
    );
    while (panes.length < 4) panes.push(null);
    const grid = {
      activeProjectKey: "/fixture/Gyro",
      maximizedPaneId: maximize,
      layouts: {
        "/fixture/Gyro": {
          projectKey: "/fixture/Gyro",
          slots: panes,
          arrangement,
          focusedPaneId: focused,
        },
      },
    };
    await evaluate(`window.__chatDragFixture.setGrid(${JSON.stringify(grid)})`);
    await assertOrder(ids.filter(Boolean));
  };
  const quickDrop = (id, x = 0.98, y = 0.5, pane = false, hidden = false) =>
    evaluate(
      `(()=>{__dragTest.start(${JSON.stringify(id)},${pane});const result=__dragTest.event('drop',${x},${y},${hidden});__dragTest.end();return result})()`,
    );

  assert.equal((await quickDrop("beta", 0.98, 0.5, false, true)).blocked, true);
  await assertOrder(["alpha", "beta"]);
  await noFeedback();
  // Type through real browser input. The draft must follow its pane when moved.
  const composer = await evaluate(
    `(()=>{const pane=Array.from(document.querySelectorAll('.gyro-chat-grid-slot')).find(p=>p.querySelector('[data-chat-pane-drag="alpha"]'));const input=pane.querySelector('textarea');input.focus();const r=input.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
  );
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...composer,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...composer,
  });
  await call("Input.insertText", { text: "retain this draft" });
  await until(
    async () => (await state()).drafts.alpha === "retain this draft",
    "typed draft",
  );
  await quickDrop("gamma", 0.02, 0.5, false, true);
  await assertOrder(["gamma", "alpha", "beta"]);
  assert.equal((await state()).drafts.alpha, "retain this draft");
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('.gyro-chat-grid-slot')).find(p=>p.querySelector('[data-chat-pane-drag="alpha"]')).querySelector('textarea').value`,
    ),
    "retain this draft",
  );

  await setLayout(["alpha", "beta", "gamma", "delta"]);
  await quickDrop("alpha", 0.98, 0.5, true, true);
  await assertOrder(["beta", "gamma", "delta", "alpha"]);
  await quickDrop("epsilon");
  await assertOrder(["beta", "gamma", "delta", "alpha"]);
  await noFeedback();

  await setLayout(["alpha", "beta", "gamma", "delta"], "grid", "alpha", "beta");
  const beforeRejected = (await state()).grid;
  assert.equal((await quickDrop("epsilon", 0.2, 0.2)).blocked, true);
  assert.deepEqual(
    (await state()).grid,
    beforeRejected,
    "full quadrants preserve panes/focus/maximize",
  );
  await quickDrop("alpha", 0.2, 0.2, true, true);
  assert.deepEqual(
    (await state()).grid,
    beforeRejected,
    "source quadrant is a true no-op",
  );
  await quickDrop("alpha", 0.8, 0.8, true, true);
  await assertOrder(["delta", "beta", "gamma", "alpha"]);
  assert.equal((await state()).grid.maximizedPaneId, undefined);

  await setLayout(["alpha", "beta", "gamma"], "columns", "beta", "beta");
  const sameBoundary = (await state()).grid;
  await quickDrop("beta", 1 / 3, 0.5, false, true);
  assert.deepEqual(
    (await state()).grid,
    sameBoundary,
    "boundary before source preserves maximization",
  );
  await quickDrop("beta", 2 / 3, 0.5, false, true);
  assert.deepEqual(
    (await state()).grid,
    sameBoundary,
    "boundary after source preserves maximization",
  );

  // One-to-two always stays a left/right split, even at every corner.
  for (const [x,y] of [[.1,.1],[.9,.1],[.1,.9],[.9,.9]]) {
    await setLayout(["alpha"]);
    await evaluate(`__dragTest.start('beta');__dragTest.event('dragover',${x},${y},true)`);
    await until(()=>evaluate("document.querySelector('.gyro-chat-grid-drop-overlay')?.dataset.layout==='columns'"),"single-chat split preview");
    assert.equal(await evaluate("document.querySelectorAll('.gyro-chat-grid-drop-zone').length"),2);
    await evaluate(`__dragTest.event('drop',${x},${y},true);__dragTest.end()`);
    await assertOrder(x<.5 ? ["beta","alpha"]:["alpha","beta"]);
    await noFeedback();
  }

  // Two-to-three offers wide insertion tiles, then changes to full quadrants
  // as the same gesture enters a corner, and back when it returns to the row.
  await setLayout(["alpha","beta"]);
  await evaluate("__dragTest.start('gamma');__dragTest.event('dragover',.5,.5,true)");
  await until(()=>evaluate("document.querySelector('[data-position=row-seam-1]')?.classList.contains('is-drop-target')"),"broad row preview");
  const rowTiles=await evaluate("Array.from(document.querySelectorAll('.gyro-chat-grid-drop-zone')).map(z=>({width:z.getBoundingClientRect().width,height:z.getBoundingClientRect().height}))");
  assert.equal(rowTiles.length,3);
  assert.ok(rowTiles.every(r=>r.width>250 && r.height>500),"insertion targets cover broad chat sections");
  await screenshot("wide-row-drop-targets.png");
  await evaluate("__dragTest.event('dragover',.85,.85,true)");
  await until(()=>evaluate("document.querySelector('[data-position=position-4]')?.classList.contains('is-drop-target')"),"bottom-right quadrant preview");
  assert.equal(await evaluate("document.querySelector('.gyro-chat-grid-drop-overlay').dataset.layout"),"positions");
  await screenshot("corner-grid-drop-targets.png");
  await evaluate("__dragTest.event('dragover',.5,.5,true)");
  await until(()=>evaluate("document.querySelector('[data-position=row-seam-1]')?.classList.contains('is-drop-target')"),"return to row preview");
  // Release into a different layout before React has painted the new overlay.
  await evaluate("__dragTest.event('drop',.85,.85,true);__dragTest.end()");
  await assertOrder(["alpha","beta","gamma"]);
  const cornerState=(await state()).grid.layouts["/fixture/Gyro"];
  assert.equal(cornerState.arrangement,"grid");
  assert.equal(cornerState.slots[3].sessionId,"gamma");
  assert.equal(cornerState.slots[2],null);
  assert.equal((await state()).drafts.alpha,"retain this draft");
  await noFeedback();
  await screenshot("corner-three-chat-layout.png");
  await quickDrop("delta",.15,.85,false,true);
  await assertOrder(["alpha","beta","delta","gamma"]);
  assert.equal((await state()).grid.layouts["/fixture/Gyro"].arrangement,"grid");

  // A pane can choose grid placement without changing its existing quadrant.
  await setLayout(["alpha","beta","gamma"]);
  await quickDrop("beta",.85,.15,true,true);
  await assertOrder(["alpha","beta","gamma"]);
  assert.equal((await state()).grid.layouts["/fixture/Gyro"].arrangement,"grid");

  // The same corner operation fits a narrower window.
  await call("Emulation.setDeviceMetricsOverride",{width:860,height:620,deviceScaleFactor:1,mobile:false});
  await setLayout(["alpha","beta"]);
  await quickDrop("gamma",.85,.85,false,true);
  assert.equal((await state()).grid.layouts["/fixture/Gyro"].slots[3].sessionId,"gamma");
  await noFeedback();
  await call("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});

  await setLayout(["alpha", "beta"], "rows");
  await evaluate(
    "__dragTest.start('gamma');__dragTest.event('dragover',.5,.5,true)",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-chat-grid-drop-overlay')?.dataset.layout === 'stack'",
      ),
    "stack targets mount",
  );
  const stackGeometry = await evaluate(
    `Array.from(document.querySelectorAll('.gyro-chat-grid-drop-zone')).map(z=>({position:z.dataset.position,height:z.getBoundingClientRect().height,width:z.getBoundingClientRect().width,active:z.classList.contains('is-drop-target')}))`,
  );
  assert.equal(stackGeometry.length, 3);
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.gyro-chat-grid-drop-overlay')).pointerEvents",
    ),
    "none",
    "native drag feedback does not intercept its source",
  );
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('.gyro-chat-grid-drop-zone')).every(zone=>getComputedStyle(zone).pointerEvents==='none')",
    ),
    true,
  );
  assert.ok(
    stackGeometry.every((zone) => zone.height > 150 && zone.width > 500),
  );
  assert.equal(
    stackGeometry.find((zone) => zone.active)?.position,
    "stack-seam-1",
  );
  await screenshot("stack-drop-targets.png");
  await evaluate("__dragTest.event('drop',.5,.5,true);__dragTest.end()");
  await assertOrder(["alpha", "gamma", "beta"]);
  assert.equal(
    (await state()).grid.layouts["/fixture/Gyro"].arrangement,
    "rows",
  );

  // Resizing under a stationary pointer can change row intent into a corner.
  await setLayout(["alpha", "beta"]);
  await evaluate("__dragTest.start('gamma');__dragTest.event('dragover',.6,.85,true)");
  await until(()=>evaluate("document.querySelector('.gyro-chat-grid-drop-overlay')?.dataset.layout==='row'"),"row intent before resize");
  await evaluate("document.querySelector('.gyro-chat-grid').style.width='70%'");
  await until(()=>evaluate("document.querySelector('[data-position=position-4]')?.classList.contains('is-drop-target')"),"corner intent after resize");
  await evaluate("document.querySelector('.gyro-chat-grid').style.width=''");
  await until(()=>evaluate("document.querySelector('.gyro-chat-grid-drop-overlay')?.dataset.layout==='row'"),"row intent after restoring size");
  await evaluate("__dragTest.end()");
  await noFeedback();

  // The preview under a stationary pointer survives layout changes/resizes.
  await setLayout(["alpha", "beta"]);
  await evaluate(
    "__dragTest.start('gamma');__dragTest.event('dragover',.5,.5,true)",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('[data-position=row-seam-1].is-drop-target'))",
      ),
    "row seam lights",
  );
  await evaluate("document.querySelector('.gyro-chat-grid').style.width='70%'");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.gyro-chat-grid-drop-zone.is-drop-target'))",
      ),
    "stationary resized preview",
  );
  await evaluate(
    "document.querySelector('.gyro-chat-grid').style.width=''; window.dispatchEvent(new Event('blur'))",
  );
  await noFeedback();
  await quickDrop("gamma", 0.5);
  await assertOrder(["alpha", "gamma", "beta"]);

  for (const cancel of [
    "window.dispatchEvent(new Event('blur'))",
    "window.dispatchEvent(new Event('pagehide'))",
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    "__dragTest.end()",
    "__dragTest.event('drop',.5,.5,true,true)",
  ]) {
    const before = (await state()).grid;
    await evaluate(
      "__dragTest.start('epsilon');__dragTest.event('dragover',.5,.5,true)",
    );
    await until(
      () =>
        evaluate(
          "Boolean(document.querySelector('.gyro-chat-grid-drop-overlay'))",
        ),
      "drag starts",
    );
    await evaluate(cancel);
    await noFeedback();
    assert.deepEqual(
      (await state()).grid,
      before,
      "cancellation preserves grid",
    );
  }
  // Removing a dragged pane invalidates its fallback without a native dragend.
  await evaluate("__dragTest.start('gamma',true)");
  await setLayout(["alpha", "beta"]);
  await noFeedback();
  assert.equal(
    await evaluate("__dragTest.fresh('text/plain','ordinary text')"),
    false,
    "unrelated text is not claimed as chat",
  );
  for (const payload of [
    "bad JSON",
    '{"sessionId":"epsilon","projectKey":7}',
    JSON.stringify({
      sessionId: "does-not-exist",
      projectKey: "/fixture/Gyro",
    }),
  ]) {
    const before = (await state()).grid;
    assert.equal(
      await evaluate(
        `__dragTest.fresh('application/x-gyro-chat-session',${JSON.stringify(payload)})`,
      ),
      true,
    );
    assert.deepEqual((await state()).grid, before);
  }
  const beforeOutside = (await state()).grid;
  await evaluate(
    "__dragTest.start('epsilon');__dragTest.event('drop',1.1,.5,true);__dragTest.end()",
  );
  assert.deepEqual(
    (await state()).grid,
    beforeOutside,
    "coordinates outside the grid reject a synthetic targeted drop",
  );
  await noFeedback();

  // Delayed events from the old native token cannot overwrite a new preview.
  await setLayout(["alpha", "beta"]);
  await evaluate(
    "__dragTest.start('gamma');window.__oldTransfer=__dragTest.transfer;__dragTest.start('delta');window.__newTransfer=__dragTest.transfer;__dragTest.event('dragover',.98,.5)",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('[data-position=row-end].is-drop-target'))",
      ),
    "new drag preview",
  );
  assert.equal(
    await evaluate(
      "__dragTest.transfer=__oldTransfer;const rejected=__dragTest.event('drop',.1,.5).blocked;__dragTest.transfer=__newTransfer;rejected",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('[data-position=row-end].is-drop-target'))",
    ),
    true,
    "old native drop preserves current preview",
  );
  await evaluate("__dragTest.event('drop',.98,.5);__dragTest.end()");
  await assertOrder(["alpha", "beta", "delta"]);
  await noFeedback();

  // A foreign project's switch target stays valid even over a full grid.
  await setLayout(["alpha", "beta", "gamma", "delta"], "grid");
  await evaluate(
    "__dragTest.start('zeta');__dragTest.event('dragover',.1,.1,true)",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('[data-position=full].is-drop-target'))",
      ),
    "foreign project target over full layout",
  );
  await evaluate("__dragTest.event('drop',.1,.1,true);__dragTest.end()");
  await assertOrder(["zeta"]);
  assert.equal((await state()).grid.activeProjectKey, "/fixture/Other");
  assert.deepEqual(
    (await state()).grid.layouts["/fixture/Gyro"].slots
      .filter(Boolean)
      .map((p) => p.sessionId),
    ["alpha", "beta", "gamma", "delta"],
  );

  // Complete real mouse gestures through production source handlers. These
  // reproduce the recording's release over Environment > Processes and prove
  // capture routing, without substituting a synthetic native drop.
  await evaluate(
    "window.__nativeDragEvents=[];window.addEventListener('dragstart',event=>__nativeDragEvents.push({blocked:event.defaultPrevented}))",
  );
  await evaluate(
    `window.__pointerEvents=[]; for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','blur']) window.addEventListener(type,event=>{__pointerEvents.push({type,buttons:event.buttons,pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary,prevented:event.defaultPrevented,target:event.target.className}); if(__pointerEvents.length>30)__pointerEvents.shift()},true)`,
  );
  const row = (id) =>
    `Array.from(document.querySelectorAll('.gyro-session-row')).find(row=>row.textContent.includes('Fixture chat '+${JSON.stringify(id)})).querySelector('.gyro-sidebar-thread-main')`;
  const pointOf = (selector) =>
    evaluate(
      `(()=>{const source=${selector};if(!source)throw Error('Missing mouse target');const r=source.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    );
  const mouseMove = (point, held = true) =>
    call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: held ? "left" : "none",
      buttons: held ? 1 : 0,
      ...point,
    });
  const mouseRelease = (point) =>
    call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      ...point,
    });
  const mouseStart = async (selector) => {
    const point = await pointOf(selector);
    await mouseMove(point, false);
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      ...point,
    });
    await mouseMove({ x: point.x + 12, y: point.y + 1 });
    await until(
      () =>
        evaluate(
          "document.documentElement.classList.contains('gyro-chat-pointer-dragging')",
        ),
      "pointer drag activates",
    );
    return point;
  };
  const gridPoint = (x = 0.98, y = 0.6) =>
    evaluate(
      `(()=>{const r=document.querySelector('.gyro-chat-grid').getBoundingClientRect();return {x:r.left+r.width*${x},y:r.top+r.height*${y}}})()`,
    );
  // Real mouse input uses the same wide sections and adaptive grid intent.
  await setLayout(["alpha","beta"]);
  await mouseStart(row("Gamma"));
  await mouseMove(await gridPoint(.5,.5));
  await until(()=>evaluate("document.querySelector('[data-position=row-seam-1]')?.classList.contains('is-drop-target')"),"mouse enters a wide insertion tile");
  await evaluate("document.documentElement.dataset.theme='light'");
  await screenshot("wide-row-light.png");
  await mouseMove(await gridPoint(.85,.85));
  await until(()=>evaluate("document.querySelector('[data-position=position-4]')?.classList.contains('is-drop-target')"),"mouse enters bottom-right quadrant");
  await screenshot("corner-grid-light.png");
  await mouseRelease(await gridPoint(.85,.85));
  await assertOrder(["alpha","beta","gamma"]);
  assert.equal((await state()).grid.layouts["/fixture/Gyro"].slots[3].sessionId,"gamma");
  assert.equal((await state()).drafts.alpha,"retain this draft");
  await noFeedback();
  await evaluate("document.documentElement.dataset.theme='dark'");

  await setLayout(["alpha"]);
  const plainClick = await pointOf(row("Alpha"));
  await mouseMove(plainClick, false);
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    ...plainClick,
  });
  await mouseRelease(plainClick);
  assert.equal(
    (await state()).active,
    "alpha",
    "ordinary sidebar click still selects",
  );
  await noFeedback();

  await mouseStart(row("Beta"));
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('.gyro-session-row.is-dragging[aria-grabbed=true]'))",
    ),
    true,
    "sidebar source reflects the active pointer gesture",
  );
  await mouseMove(await gridPoint(0.15));
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('[data-position=left].is-drop-target'))",
      ),
    "left preview follows mouse",
  );
  const processes = await pointOf(
    "Array.from(document.querySelectorAll('.gyro-chat-environment-popover-rows button')).find(button=>button.textContent.includes('Processes'))",
  );
  await mouseMove(processes);
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('[data-position=right].is-drop-target'))",
      ),
    "right preview over nested Environment row",
  );
  await screenshot("pointer-environment-preview.png");
  await mouseRelease(processes);
  await assertOrder(["alpha", "beta"]);
  await noFeedback();
  assert.equal(
    (await state()).active,
    "beta",
    "release focuses the dropped chat",
  );
  assert.equal((await state()).drafts.alpha, "retain this draft");
  await screenshot("pointer-environment-split.png");

  await mouseStart(row("Alpha"));
  const farRight = await gridPoint();
  await mouseMove(farRight);
  await mouseRelease(farRight);
  await assertOrder(["beta", "alpha"]);
  await noFeedback();
  assert.equal(
    (await state()).drafts.alpha,
    "retain this draft",
    "draft survives real pane reorder",
  );

  // Releasing over the other pane swaps the two chats.
  for (const arrangement of ["columns", "rows"]) {
    for (const [source, fraction, expected] of [
      ["beta", 0.4, ["beta", "alpha"]],
      ["alpha", 0.6, ["beta", "alpha"]],
    ]) {
      await setLayout(["alpha", "beta"], arrangement);
      await mouseStart(row(source[0].toUpperCase() + source.slice(1)));
      const destination = arrangement === "columns"
        ? await gridPoint(fraction, 0.6)
        : await gridPoint(0.6, fraction);
      await mouseMove(destination);
      await mouseRelease(destination);
      await assertOrder(expected);
      await noFeedback();
      assert.equal((await state()).drafts.alpha, "retain this draft");
    }
  }
  await setLayout(["beta", "alpha"]);

  // Outside release and Escape cannot select the source via the follow-up click.
  await mouseStart(row("Gamma"));
  await mouseMove(await gridPoint(0.02));
  const outside = await pointOf(row("Alpha"));
  await mouseMove(outside);
  await until(
    () => evaluate("!document.querySelector('.gyro-chat-grid.is-dragging')"),
    "leaving grid clears preview",
  );
  const pointerBeforeOutside = await state();
  await mouseRelease(outside);
  await noFeedback();
  await assertOrder(["beta", "alpha"]);
  assert.equal(
    (await state()).active,
    pointerBeforeOutside.active,
    "outside drag release does not select source",
  );

  await mouseStart(row("Gamma"));
  const cancelPoint = await gridPoint();
  await mouseMove(cancelPoint);
  const beforeEscape = (await state()).grid;
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await mouseRelease(cancelPoint);
  await noFeedback();
  assert.deepEqual(
    (await state()).grid,
    beforeEscape,
    "Escape preserves layout",
  );

  const beforeModal = await state();
  await mouseStart(row("Gamma"));
  const modalPoint = await gridPoint();
  await evaluate(`(() => {
    const modal = document.createElement('div');
    modal.id = 'pointer-modal-test';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white';
    document.body.appendChild(modal);
  })()`);
  await mouseMove(modalPoint);
  await mouseRelease(modalPoint);
  await noFeedback();
  assert.deepEqual(
    (await state()).grid,
    beforeModal.grid,
    "a covering modal cannot drop into the hidden grid",
  );
  assert.equal((await state()).active, beforeModal.active);
  await evaluate("document.getElementById('pointer-modal-test').remove()");

  await setLayout(["alpha", "beta", "gamma", "delta"]);
  const beforeFull = await state();
  await mouseStart(row("Epsilon"));
  const fullPoint = await gridPoint();
  await mouseMove(fullPoint);
  await mouseRelease(fullPoint);
  await noFeedback();
  assert.deepEqual(
    (await state()).grid,
    beforeFull.grid,
    "full layout rejects real pointer drop",
  );
  assert.equal(
    (await state()).active,
    beforeFull.active,
    "rejected drag does not click/select source",
  );
  assert.equal(
    await evaluate(
      "document.documentElement.classList.contains('gyro-chat-pointer-dragging')",
    ),
    false,
    "cursor/capture feedback clears",
  );
  assert.deepEqual(
    await evaluate("window.__nativeDragEvents"),
    [],
    "internal mouse gestures never hand identity to native drag storage",
  );

  // An OS file drag cancels stranded chat feedback and still reaches its own
  // composer exactly once, without moving chats or inserting their IDs.
  const beforeFile = (await state()).grid;
  await evaluate(
    `(()=>{__dragTest.start('epsilon');const transfer=new DataTransfer();transfer.items.add(new File(['image'], 'fixture.png',{type:'image/png'}));const input=Array.from(document.querySelectorAll('.gyro-chat-grid-slot')).find(p=>p.querySelector('[data-chat-pane-drag=alpha]')).querySelector('textarea');const r=input.getBoundingClientRect();for(const type of ['dragenter','dragover','drop'])input.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:r.left+r.width/2,clientY:r.top+r.height/2}))})()`,
  );
  await until(
    async () => (await state()).media === 1,
    "external image reaches one composer",
  );
  await noFeedback();
  assert.deepEqual(
    (await state()).grid,
    beforeFile,
    "external file drag preserves chat layout",
  );

  await call("Emulation.setDeviceMetricsOverride", {
    width: 760,
    height: 620,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await setLayout(["alpha", "beta", "gamma"], "columns");
  await evaluate(
    "__dragTest.start('delta');__dragTest.event('dragover',.7,.5,true)",
  );
  await until(
    () =>
      evaluate(
        "document.querySelectorAll('.gyro-chat-grid-drop-zone').length===4",
      ),
    "narrow row targets",
  );
  await screenshot("narrow-row-drop-targets.png");
  await evaluate("__dragTest.event('drop',.7,.5,true);__dragTest.end()");
  await assertOrder(["alpha", "beta", "delta", "gamma"]);
  await noFeedback();
  assert.equal(
    (await state()).media,
    1,
    "only the explicit image became an attachment",
  );
  assert.deepEqual(
    errors,
    [],
    "no renderer exceptions during adversarial drag sequences",
  );
  console.log(
    "Chat drag browser checks passed: quick/protected releases, pane/sidebar moves, row/stack/grid targets, capacity, cancellation, drafts, maximize, foreign projects, narrow layouts.",
  );
} catch (error) {
  if (screenshot) await screenshot("failure.png").catch(() => {});
  if (evaluate)
    console.error(
      "Fixture state:",
      await evaluate(
        "({state:window.__chatDragFixture?.getState(),nativeDragEvents:window.__nativeDragEvents,pointerEvents:window.__pointerEvents,text:document.body.innerText.slice(0,2500)})",
      ).catch(() => undefined),
    );
  throw error;
} finally {
  ws?.close();
  if (browser.exitCode === null) {
    browser.kill("SIGTERM");
    await new Promise((resolve) =>
      browser.exitCode !== null ? resolve() : browser.once("exit", resolve),
    );
  }
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
