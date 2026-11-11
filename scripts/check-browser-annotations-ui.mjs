import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1431";
const profile = await mkdtemp(join(tmpdir(), "gyro-annotation-ui-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ||
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=" + profile,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await pause(100);
  }
  throw Error("Timed out: " + label);
}
const checks = [];
try {
  const port = await until(
    async () =>
      Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      ),
    "browser",
  );
  const pages = await (
    await fetch("http://127.0.0.1:" + port + "/json/list")
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
    const result = JSON.parse(String(data));
    const task = pending.get(result.id);
    if (!task) return;
    pending.delete(result.id);
    clearTimeout(task.timer);
    result.error ? task.reject(result.error) : task.resolve(result.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(method + " timeout"));
      }, 15000);
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
  const click = async (label) => {
    await evaluate(
      `(() => { const button=[...document.querySelectorAll('button')].find(el => el.textContent.trim()===${JSON.stringify(label)} || el.getAttribute('aria-label')===${JSON.stringify(label)}); if(!button || button.disabled) throw Error('Unavailable button'); button.click(); })()`,
    );
  };
  const input = async (text) =>
    evaluate(`(() => {
    const el=document.querySelector('[aria-label="Element feedback"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  const selected = () =>
    until(
      () =>
        evaluate(`!!document.querySelector('[aria-label="Element feedback"]')`),
      "selection",
    );
  await call("Page.enable");
  await mkdir("artifacts/browser-annotations", { recursive: true });
  for (const { theme, width, name } of [
    { theme: "dark", width: 420, name: "dark" },
    { theme: "light", width: 420, name: "light" },
    { theme: "dark", width: 1000, name: "wide" },
  ]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", {
      url: origin + "/browser-annotations-fixture.html?theme=" + theme,
    });
    await until(
      () =>
        evaluate(`!!document.querySelector('[aria-label="Browser options"]')`),
      "fixture",
    );
    const toolbar = await evaluate(`(() => {
      const b=document.querySelector('[aria-label="Annotatie"]'),m=document.querySelector('[aria-label="Browser options"]');
      const a=b.getBoundingClientRect(), menu=m.getBoundingClientRect();
      return {label:getComputedStyle(b.querySelector('span')).display,center:a.top+a.height/2,menuCenter:menu.top+menu.height/2};
    })()`);
    assert.ok(
      Math.abs(toolbar.center - toolbar.menuCenter) < 2,
      "annotation and menu stay on one row",
    );
    assert.equal(
      toolbar.label === "none",
      width <= 470,
      "responsive annotation label",
    );
    if (name === "wide") {
      const toolbarShot = await call("Page.captureScreenshot", {
        format: "png",
      });
      await writeFile(
        "artifacts/browser-annotations/toolbar.png",
        Buffer.from(toolbarShot.data, "base64"),
      );
    }
    await click("Annotatie");
    await until(
      () =>
        evaluate(
          `!!document.querySelector('[aria-label="Element annotation"]')`,
        ),
      "picker",
    );
    await click("Fixture: choose target");
    await selected();
    await input("Make the primary action clearer.");
    await pause(250);
    const geometry = await evaluate(`(() => {
      const form=document.querySelector('[aria-label="Element annotation"]');
      const frame=document.querySelector('.gyro-browser-frame');
      const a=form.getBoundingClientRect(),b=frame.getBoundingClientRect();
      const text=document.querySelector('textarea').getBoundingClientRect();
      return {form:{top:a.top,bottom:a.bottom,height:a.height},frameTop:b.top,textRight:text.right,viewport:innerWidth,
        head:getComputedStyle(form.parentElement).cssText,
        rows:getComputedStyle(document.querySelector('.gyro-browser-preview')).gridTemplateRows};
    })()`);
    assert.ok(
      geometry.form.top >= geometry.frameTop - 1,
      JSON.stringify(geometry),
    );
    assert.ok(geometry.textRight <= geometry.viewport, "no narrow overflow");
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      "artifacts/browser-annotations/" + name + ".png",
      Buffer.from(shot.data, "base64"),
    );
    await evaluate(
      `(() => {const form=document.querySelector('[aria-label="Element annotation"]');form.requestSubmit();form.requestSubmit();})()`,
    );
    await until(
      () =>
        evaluate(
          'document.querySelector("output").textContent === "Make the primary action clearer."',
        ),
      "draft",
    );
    assert.equal(
      await evaluate('document.querySelector("output").dataset.sends'),
      "1",
      "duplicate submit creates one message",
    );
    assert.ok(
      await evaluate(
        `!!document.querySelector('img[alt="Sent annotation crop"]')`,
      ),
      "crop reaches fixture chat",
    );
    if (name === "wide") {
      const sentShot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        "artifacts/browser-annotations/sent-fixture.png",
        Buffer.from(sentShot.data, "base64"),
      );
    }
    checks.push(
      name + ": capture, bubble placement, send with image, responsive toolbar",
    );
    await click("Annotatie");
    await click("Fixture: choose target");
    await selected();
    await input("Keep this comment");
    await click("Fixture: toggle stale");
    await click("Send");
    await until(
      () =>
        evaluate(
          `document.querySelector('[role="alert"]')?.textContent.includes("Could not send")`,
        ),
      "send error",
    );
    assert.equal(
      await evaluate('document.querySelector("textarea").value'),
      "Keep this comment",
    );
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await until(
      () =>
        evaluate(
          `!document.querySelector('[aria-label="Element annotation"]')`,
        ),
      "escape",
    );
    checks.push(theme + ": stale error preserves comment; Escape closes");
  }
  await call("Page.navigate", {
    url: origin + "/browser-annotations-fixture.html?capture&theme=light",
  });
  await until(
    () =>
      evaluate(
        'document.querySelector(".gyro-browser-capture-view")?.dataset.imageState==="ready"',
      ),
    "capture",
  );
  await click("Select element");
  const capturePoint = await evaluate(`(() => {
    const layer=document.querySelector('[aria-label="Select an element of the browser capture"]');
    const image=document.querySelector('img.gyro-browser-capture-image'),r=image.getBoundingClientRect();
    const w=Math.min(r.width,r.height*960/640),h=w*640/960;
    const x=r.left+(r.width-w)/2+w/10,y=r.top+h/10;
    layer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y}));
    return {x,y};
  })()`);
  await selected();
  await input("Capture comment");
  await click("Add to chat");
  await until(
    () =>
      evaluate(
        'document.querySelector("output").textContent==="Capture comment"',
      ),
    "capture draft",
  );
  checks.push("capture: scaled image selection and composer comment");
  await click("Select element");
  await click("Fixture: toggle stale");
  await evaluate(
    `document.querySelector('[aria-label="Select an element of the browser capture"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:${capturePoint.x},clientY:${capturePoint.y}}))`,
  );
  await until(
    () =>
      evaluate(
        `document.querySelector('[role="alert"]')?.textContent.includes("stale")`,
      ),
    "capture stale",
  );
  checks.push("capture: stale state offers Live");
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => browser.once("exit", resolve)),
    pause(3000),
  ]);
  if (browser.exitCode === null) browser.kill("SIGKILL");
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
