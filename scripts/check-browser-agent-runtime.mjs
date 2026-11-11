// Execute the shipped DOM agent in a fresh headless browser; no app or server needed.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
  annotations: await readFile(
    "apps/desktop/src-tauri/src/browser_annotations.js",
    "utf8",
  ),
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
  if (!baseline) {
    await check(
      "annotation selection suppresses page clicks and shares actionable refs",
      `(() => {
      const button = document.querySelector('button');
      button.id = 'annotated';
      window.annotationClicks = 0;
      button.onclick = () => window.annotationClicks++;
      __gyroBrowserAgent.annotate({action:'start',token:'selection'});
      const rect = button.getBoundingClientRect();
      button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:rect.x+2,clientY:rect.y+2}));
      const result = __gyroBrowserAgent.annotate({action:'read',token:'selection'});
      window.savedAnnotation = result.annotation;
      return !result.active && annotationClicks === 0 && result.annotation.tag === 'button'
        && result.annotation.styles.display && result.annotation.selector === '#annotated'
        && __gyroBrowserAgent.readPage({ref:result.annotation.ref}).ok;
    })()`,
    );
    await check(
      "capture hit testing rejects mutation, scroll and epoch changes",
      `(() => {
      const before = __gyroBrowserAgent.status().annotationState;
      const rect = document.querySelector('button').getBoundingClientRect();
      const options = {action:'point',token:'capture',captureState:before,x:rect.x+2,y:rect.y+2};
      const valid = __gyroBrowserAgent.annotate(options).ok;
      const wrongEpoch = __gyroBrowserAgent.annotate({...options,captureState:{...before,documentEpoch:'old'}}).ok === false;
      const wrongScroll = __gyroBrowserAgent.annotate({...options,captureState:{...before,viewport:{...before.viewport,scrollY:100}}}).ok === false;
      document.querySelector('button').textContent = 'Changed';
      return valid && wrongEpoch && wrongScroll && __gyroBrowserAgent.annotate(options).ok === false;
    })()`,
    );
    await check(
      "annotation validation rejects replaced nodes instead of re-targeting selector",
      `(() => {
      const button = document.querySelector('button');
      button.replaceWith(button.cloneNode(true));
      return __gyroBrowserAgent.annotate({action:'validate',annotation:savedAnnotation}).ok === false;
    })()`,
    );
    await check(
      "protected fields and embedded frames are not annotated",
      `(() => {
      document.body.innerHTML = '<input type="password" value="hidden-password"><textarea>private draft</textarea><iframe></iframe>';
      return [...document.body.children].every(el => {
        const rect = el.getBoundingClientRect();
        return __gyroBrowserAgent.annotate({action:'point',token:'protected',
          captureState:__gyroBrowserAgent.status().annotationState,x:rect.x+2,y:rect.y+2}).ok === false;
      });
    })()`,
    );
    await check(
      "annotation text excludes descendant field values and HTML",
      `(() => {
      document.body.innerHTML = '<section id="card" style="padding:20px">Visible heading<input value="hidden-input"><textarea>hidden-textarea</textarea><div contenteditable>hidden-editable</div></section>';
      const rect = document.querySelector('section').getBoundingClientRect();
      const result = __gyroBrowserAgent.annotate({action:'point',token:'text',
        captureState:__gyroBrowserAgent.status().annotationState,x:rect.x+2,y:rect.y+2});
      const text = JSON.stringify(result);
      return result.ok && result.annotation.text.includes('Visible heading') && !text.includes('hidden-');
    })()`,
    );
    await check(
      "Escape releases selection and stale cleanup cannot stop another picker",
      `(() => {
      __gyroBrowserAgent.annotate({action:'start',token:'old'});
      __gyroBrowserAgent.annotate({action:'start',token:'new'});
      __gyroBrowserAgent.annotate({action:'stop',token:'old'});
      const stillActive = __gyroBrowserAgent.annotate({action:'read',token:'new'}).active;
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));
      return stillActive && !__gyroBrowserAgent.annotate({action:'read',token:'new'}).active;
    })()`,
    );
    await check(
      "keyboard Enter selects a focused page element without activating it",
      `(() => {
      document.body.innerHTML = '<button id="keyboard">Keyboard target</button>';
      const button = document.querySelector('button'); button.focus();
      __gyroBrowserAgent.annotate({action:'start',token:'keyboard'});
      button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      return __gyroBrowserAgent.annotate({action:'read',token:'keyboard'}).annotation?.selector === '#keyboard';
    })()`,
    );
  }
  if (!baseline) {
    const framePoint = await evaluate(`(async () => {
      const frame = document.createElement('iframe');
      frame.srcdoc = '<button style="width:200px;height:100px">Embedded action</button>';
      const loaded = new Promise(resolve => frame.onload = resolve);
      document.body.replaceChildren(frame); await loaded;
      window.embeddedClicks = 0;
      frame.contentDocument.querySelector('button').onclick = () => embeddedClicks++;
      __gyroBrowserAgent.annotate({action:'start',token:'frame-check'});
      const rect = frame.getBoundingClientRect();
      return {x:rect.x+30,y:rect.y+30};
    })()`);
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...framePoint,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...framePoint,
    });
    await check(
      "real pointer clicks over embedded frames are intercepted by the selection layer",
      `(() => {
      const result = __gyroBrowserAgent.annotate({action:'read',token:'frame-check'});
      __gyroBrowserAgent.annotate({action:'stop',token:'frame-check'});
      return embeddedClicks === 0 && result.active && result.error.includes('embedded frames');
    })()`,
    );
    await evaluate(
      "__gyroBrowserAgent.annotate({action:'start',token:'expiry'})",
    );
    await pause(3200);
    await check(
      "abandoned selection releases its input shield",
      `(() => {
      const result = __gyroBrowserAgent.annotate({action:'read',token:'expiry'});
      return !result.active && !document.querySelector('[data-gyro-browser-annotation-shield]');
    })()`,
    );
  }
  if (!baseline) {
    await check(
      "card text selects its visual container; outline follows asymmetric radii",
      `(async () => {
      document.body.innerHTML='<article id="shape-card" style="position:fixed;left:50px;top:50px;width:240px;height:160px;border-radius:32px 8px 24px 0;background:white"><h2>Card heading</h2></article>';
      const title=document.querySelector('h2'),r=title.getBoundingClientRect();
      __gyroBrowserAgent.annotate({action:'start',token:'shape'});
      window.dispatchEvent(new PointerEvent('pointermove',{clientX:r.x+20,clientY:r.y+10}));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const path=document.querySelector('[data-gyro-browser-target] path');
      const correct=path?.getAttribute('d').includes('A32 32') && path.getAttribute('d').includes('A8 8');
      title.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:r.x+20,clientY:r.y+10}));
      const a=__gyroBrowserAgent.annotate({action:'read',token:'shape'}).annotation;
      return correct && a.selector==='#shape-card' && a.outline.exact;
    })()`,
    );
    await check(
      "transform, polygon and circle outlines use element geometry",
      `(() => {
      const el=document.querySelector('article');
      el.style.transform='rotate(15deg)';
      const ref=__gyroBrowserAgent.find({selector:'#shape-card'}).results[0].ref;
      const describe=()=>__gyroBrowserAgent.annotate({action:'validate',annotation:{ref,documentEpoch:__gyroBrowserAgent.status().annotationState.documentEpoch,url:location.href}}).annotation;
      const rotated=describe(); if(!rotated.outline.exact || Math.abs(rotated.outline.matrix[1])<.2)return false;
      el.style.transform='none';el.style.clipPath='polygon(50% 0%, 100% 100%, 0% 100%)';
      const polygon=describe();if(polygon.outline.path!=='M120 0L240 160L0 160Z')return false;
      el.style.clipPath='circle(40px at 50% 50%)';
      return describe().outline.path.includes('a40 40');
    })()`,
    );
    await check(
      "capture removes annotation graphics and rejects changed geometry",
      `(() => {
      const el=document.querySelector('article');el.style.clipPath='none';
      const r=el.getBoundingClientRect();
      const a=__gyroBrowserAgent.annotate({action:'point',token:'cap',captureState:__gyroBrowserAgent.status().annotationState,x:r.x+2,y:r.y+2}).annotation;
      const reordered=JSON.parse(JSON.stringify(a, Object.keys(a).concat(Object.keys(a.viewport),Object.keys(a.rect)).sort()));
      const clean=__gyroBrowserAgent.annotate({action:'capture',annotation:reordered});
      el.style.width='250px';
      const stale=__gyroBrowserAgent.annotate({action:'capture',annotation:a});
      return clean.ok && !document.querySelector('[data-gyro-browser-target]') && !stale.ok;
    })()`,
    );
    await check(
      "privacy masks cover nested fields and open shadow-root fields",
      `(() => {
      document.body.innerHTML='<article style="padding:20px">Card<input value="private"><div id="shadow"></div></article>';
      document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input value="shadow-private">';
      const r=document.querySelector('article').getBoundingClientRect();
      const a=__gyroBrowserAgent.annotate({action:'point',token:'mask',captureState:__gyroBrowserAgent.status().annotationState,x:r.x+2,y:r.y+2}).annotation;
      return a.protectedRects.length>=2 && a.protectedRects.every(r=>r.width>0 && r.height>0);
    })()`,
    );
  }
  if (!baseline) {
    await evaluate(`(async()=>{
      document.body.innerHTML='<h1>Annotation hover</h1><p>Runtime fixture · actual injected selector</p><article id="hover-proof"><h2>Website redesign</h2><p>Refresh the homepage and project cards.</p><small>In progress · 6 tasks</small></article>';
      document.body.style.cssText='margin:0;padding:48px;background:#f5f5f3;color:#222;font:16px system-ui';
      const card=document.querySelector('article');
      card.style.cssText='margin-top:32px;padding:24px;width:320px;height:160px;border-radius:32px 8px 24px 8px;background:white;border:1px solid #ddd';
      const rect=card.getBoundingClientRect();
      __gyroBrowserAgent.annotate({action:'start',token:'hover-proof'});
      window.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.x+30,clientY:rect.y+30}));
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    })()`);
    await mkdir("artifacts/browser-annotations", { recursive: true });
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      "artifacts/browser-annotations/hover.png",
      Buffer.from(shot.data, "base64"),
    );
  }
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
