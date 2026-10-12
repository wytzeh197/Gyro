import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real production Monaco tokenization and panes; no LSP or replacement parser.
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1423";
const artifacts =
  process.env.GYRO_TEST_ARTIFACTS ??
  "/private/tmp/gyro-workspace-syntax-browser";
const faultMode = process.env.GYRO_TEST_FAULT;
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-syntax-browser-"));
const port = 9479;
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
let socket, failureSnapshot;
const errors = [],
  requests = [],
  blocked = [],
  faults = [];
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await pause();
  }
  if (failureSnapshot)
    console.error("Syntax browser state:", await failureSnapshot());
  throw Error(`Timed out: ${description}`);
}
const roleAt = (sample, lineNumber, fragment) => {
  const line = sample.content.split("\n")[lineNumber - 1];
  const offset = line.indexOf(fragment);
  assert.ok(offset >= 0, `${sample.path}:${lineNumber} contains ${fragment}`);
  return sample.lines[lineNumber - 1].findLast(
    (token) => token.offset <= offset,
  )?.type;
};
function checkTokenization(tokenization) {
  for (const sample of tokenization) {
    assert.equal(sample.available, true, sample.path);
    assert.equal(
      roleAt(
        sample,
        sample.path.endsWith(".sass") ? 4 : 2,
        "comment starts here",
      ),
      "comment",
      "block comment opening line",
    );
    assert.equal(
      roleAt(
        sample,
        sample.path.endsWith(".sass") ? 5 : 3,
        "and continues here",
      ),
      "comment",
      "block comment state continues across lines",
    );
    if (!sample.path.endsWith(".sass")) {
      assert.equal(
        roleAt(sample, 4, "const"),
        "storageKeyword",
        `${sample.path} embedded TypeScript keyword`,
      );
      assert.equal(
        roleAt(sample, 4, "Hello"),
        "templateString",
        `${sample.path} template string opening line`,
      );
      assert.equal(
        roleAt(sample, 5, "Workspace"),
        "templateString",
        `${sample.path} template string state continues`,
      );
      assert.equal(
        roleAt(sample, 7, "h1"),
        "tag",
        `${sample.path} markup tag resumes after script`,
      );
    }
  }
  const vue = tokenization[0],
    svelte = tokenization[1],
    astro = tokenization[2],
    sass = tokenization[3];
  assert.equal(
    roleAt(vue, 11, "color"),
    "cssProperty",
    "Vue embedded SCSS property",
  );
  assert.equal(
    roleAt(vue, 10, "h1"),
    "cssSelector",
    "Vue embedded SCSS selector",
  );
  assert.equal(
    roleAt(vue, 13, "style"),
    "tag",
    "Vue SCSS closes back into markup",
  );
  assert.equal(
    roleAt(svelte, 9, "Embedded CSS comment"),
    "comment",
    "Svelte embedded CSS comment",
  );
  assert.equal(
    roleAt(svelte, 10, "continues here"),
    "comment",
    "Svelte embedded CSS comment continues",
  );
  assert.equal(
    roleAt(svelte, 11, "color"),
    "cssProperty",
    "Svelte embedded CSS property",
  );
  assert.equal(
    roleAt(svelte, 12, "style"),
    "tag",
    "Svelte CSS closes back into markup",
  );
  assert.equal(
    roleAt(astro, 8, "const"),
    "storageKeyword",
    "Astro embedded script keyword",
  );
  assert.ok(
    ["variable", "constant"].includes(roleAt(astro, 8, "ready")),
    "token offsets after astral Unicode remain UTF-16 aligned",
  );
  assert.equal(
    roleAt(astro, 12, "color"),
    "cssProperty",
    "Astro embedded CSS property",
  );
  assert.equal(
    roleAt(astro, 13, "style"),
    "tag",
    "Astro CSS closes back into markup",
  );
  assert.equal(
    roleAt(sass, 6, "welcome"),
    "cssSelector",
    "Sass indentation selector",
  );
  assert.equal(
    roleAt(sass, 7, "color"),
    "cssProperty",
    "Sass indentation property",
  );
  assert.equal(roleAt(sass, 3, "Workspace"), "string", "Sass quoted string");
}
try {
  const page = await until(async () => {
    const pages = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    return pages.find((page) => page.type === "page");
  }, "browser startup");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    if (message.method === "Network.requestWillBeSent")
      requests.push(message.params.request.url);
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      const local =
        request.url.startsWith(origin + "/") ||
        request.url.startsWith("data:") ||
        request.url.startsWith("blob:");
      const injectFault =
        faults.length === 0 &&
        ((faultMode === "wasm" && /\.wasm(?:$|\?)/.test(request.url)) ||
          (faultMode === "grammar" &&
            /\/vue\.tmLanguage(?:-[^/]+)?\.(?:js|json)(?:$|\?)/.test(
              request.url,
            )));
      if (injectFault) {
        faults.push(request.url);
        void call("Fetch.failRequest", {
          requestId,
          errorReason: "ConnectionFailed",
        });
        return;
      }
      if (!local) blocked.push(request.url);
      void call(
        local ? "Fetch.continueRequest" : "Fetch.failRequest",
        local
          ? { requestId }
          : { requestId, errorReason: "InternetDisconnected" },
      );
    }
    const result = pending.get(message.id);
    if (result) {
      pending.delete(message.id);
      message.error
        ? result.reject(message.error)
        : result.resolve(message.result);
    }
  };
  const evaluate = async (expression) => {
    const value = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (value.exceptionDetails)
      throw Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const screenshot = async (name) => {
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(join(artifacts, name), Buffer.from(data, "base64"));
  };
  failureSnapshot = async () => {
    await screenshot("syntax-failure.png");
    await writeFile(
      join(artifacts, "browser-errors.json"),
      JSON.stringify(errors, null, 2),
    );
    await writeFile(
      join(artifacts, "network.json"),
      JSON.stringify({ origin, requests, blocked, faults }, null, 2),
    );
    return evaluate(
      `window.__syntaxFixture && Promise.all(Object.keys(window.__syntaxFixture.samples).map(async path=>({path,modelLanguage:window.__syntaxFixture.model(path)?.getLanguageId(),...await window.__syntaxFixture.tokenization(path)})))`,
    );
  };
  const dimensions = (width, height) =>
    call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Network.setCacheDisabled", { cacheDisabled: true });
  // Cold load with every external origin unavailable, including any CDN.
  await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await dimensions(1440, 900);
  await call("Page.navigate", {
    url: origin + "/workspace-syntax-fixture.html",
  });
  if (faultMode) {
    await until(
      () =>
        evaluate(
          `window.__syntaxFixture && [...document.querySelectorAll('.gyro-syntax-notice')].some(notice=>notice.textContent.includes('could not be loaded'))`,
        ),
      `${faultMode} failure falls back visibly`,
    );
    assert.equal(faults.length, 1, "exactly one initial asset request failed");
    const fallbackPath = await until(
      () =>
        evaluate(
          `window.__syntaxFixture.monaco.editor.getEditors().find(editor=>editor.getModel()?.getLanguageId()==='plaintext')?.getModel().uri.path`,
        ),
      "editable fallback editor mounted",
    );
    assert.equal(
      await evaluate(
        `window.__syntaxFixture.monaco.editor.getEditors().find(editor=>editor.getModel()?.uri.path===${JSON.stringify(fallbackPath)}).getOption(window.__syntaxFixture.monaco.editor.EditorOption.readOnly)`,
      ),
      false,
      "failed highlighting leaves editing enabled",
    );
    await evaluate(
      `(()=>{const model=window.__syntaxFixture.model(${JSON.stringify(fallbackPath)});model.applyEdits([{range:model.getFullModelRange().collapseToEnd(),text:'\\n// edit during syntax failure'}]);})()`,
    );
    const recovered = await evaluate(
      `window.__syntaxFixture.tokenization('/syntax/Welcome.vue')`,
    );
    await writeFile(
      join(artifacts, "retry-result.json"),
      JSON.stringify(recovered, null, 2),
    );
    assert.equal(
      recovered.available,
      true,
      `${faultMode} failure retries in the same page`,
    );
    assert.equal(recovered.language, "gyro-tm-vue");
    assert.equal(
      recovered.lines[1][0].type,
      "comment",
      "retried provider actually tokenizes",
    );
    await evaluate(`window.__syntaxFixture.remountPanes()`);
    await until(
      () =>
        evaluate(
          `Object.keys(window.__syntaxFixture.samples).every(path=>window.__syntaxFixture.model(path)?.getLanguageId().startsWith('gyro-tm-')) && !document.querySelector('.gyro-syntax-notice')`,
        ),
      "reopened panes recover highlighting",
    );
    assert.equal(
      await evaluate(
        `window.__syntaxFixture.model(${JSON.stringify(fallbackPath)}).getValue().endsWith('// edit during syntax failure')`,
      ),
      true,
      "retry preserves text edited during failure",
    );
    const modelTokenSnapshot = () =>
      evaluate(
        `Object.keys(window.__syntaxFixture.samples).map(path=>{const model=window.__syntaxFixture.model(path);return {path,language:model.getLanguageId(),lines:Array.from({length:model.getLineCount()},(_,index)=>{const tokens=model.tokenization.getLineTokens(index+1);return {text:model.getLineContent(index+1),tokens:Array.from({length:tokens.getCount()},(_,index)=>({offset:tokens.getStartOffset(index),className:tokens.getClassName(index),metadata:tokens.getMetadata(index)}))};})};})`,
      );
    await writeFile(
      join(artifacts, "retained-tokens-before.json"),
      JSON.stringify(await modelTokenSnapshot(), null, 2),
    );
    const recoveredSamples = await evaluate(
      `Promise.all(Object.keys(window.__syntaxFixture.samples).map(async path=>({path,content:window.__syntaxFixture.samples[path],...await window.__syntaxFixture.tokenization(path)})))`,
    );
    await writeFile(
      join(artifacts, "recovered-tokenization.json"),
      JSON.stringify(recoveredSamples, null, 2),
    );
    checkTokenization(recoveredSamples);
    await until(
      () =>
        evaluate(
          `[...document.querySelectorAll('.workspace-syntax-fixture-pane')].every(pane=>{const spans=[...pane.querySelectorAll('.view-lines span[class*="mtk"]')];const text=span=>span.textContent.replace(/\\u00a0/g,' ').trim();const comment=spans.find(span=>text(span).includes('comment starts here'));const property=spans.find(span=>text(span)==='color');const styleTags=spans.filter(span=>text(span)==='style');return comment && property && getComputedStyle(comment).fontStyle==='italic' && getComputedStyle(property).color!==getComputedStyle(comment).color && (pane.dataset.path.endsWith('.sass') || styleTags.length>=2);})`,
        ),
      "every recovered pane repaints comments, embedded styles and closing tags",
    );
    await writeFile(
      join(artifacts, "retained-tokens-painted.json"),
      JSON.stringify(await modelTokenSnapshot(), null, 2),
    );
    await screenshot(`syntax-retry-${faultMode}.png`);
    await writeFile(
      join(artifacts, "network.json"),
      JSON.stringify({ origin, requests, blocked, faults }, null, 2),
    );
    await writeFile(
      join(artifacts, "browser-errors.json"),
      JSON.stringify(errors, null, 2),
    );
    assert.equal(
      errors.length,
      0,
      "handled asset failure causes no browser exceptions",
    );
    console.log(
      `Workspace syntax ${faultMode} recovery passed: visible editable fallback, same-page retry, reopened production panes recover.`,
    );
  } else {
    const modelIds = await until(
      () =>
        evaluate(
          `(()=>{const f=window.__syntaxFixture;if(!f)return;const paths=Object.keys(f.samples);const ids=paths.map(path=>f.model(path)?.getLanguageId());return ids.every(id=>id&&id!=='plaintext')&&ids;})()`,
        ),
      "four production grammars installed without LSP",
    );
    assert.deepEqual(modelIds, [
      "gyro-tm-vue",
      "gyro-tm-svelte",
      "gyro-tm-astro",
      "gyro-tm-sass",
    ]);
    const tokenization = await evaluate(
      `Promise.all(Object.keys(window.__syntaxFixture.samples).map(async path=>({path,content:window.__syntaxFixture.samples[path],...await window.__syntaxFixture.tokenization(path)})))`,
    );
    await writeFile(
      join(artifacts, "tokenization.json"),
      JSON.stringify(tokenization, null, 2),
    );
    const repeated = await evaluate(
      `Promise.all(Object.keys(window.__syntaxFixture.samples).map(async path=>({path,content:window.__syntaxFixture.samples[path],...await window.__syntaxFixture.tokenization(path)})))`,
    );
    await writeFile(
      join(artifacts, "tokenization-repeat.json"),
      JSON.stringify(repeated, null, 2),
    );
    checkTokenization(tokenization);
    // A missing grammar still returns the ordinary editable plain-text fallback.
    const fallback = await evaluate(
      `window.__syntaxFixture.tokenization('/syntax/Main.elm','module Main exposing (main)')`,
    );
    assert.equal(fallback.language, "plaintext");
    assert.equal(fallback.available, false);
    assert.ok(fallback.reason.includes("Highlighting"));
    await until(
      () =>
        evaluate(
          `document.querySelectorAll('.workspace-syntax-fixture-pane .view-line').length>25`,
        ),
      "all panes render real tokens",
    );
    const renderedPalette = () =>
      evaluate(
        `(()=>{const pane=document.querySelector('[data-path="/syntax/Welcome.vue"]');const spans=[...pane.querySelectorAll('.view-lines span[class*="mtk"]')];const text=span=>span.textContent.replace(/\\u00a0/g,' ').trim();const keyword=spans.find(span=>text(span)==='const');const comment=spans.find(span=>text(span).includes('Vue comment starts here'));return {keyword:keyword&&getComputedStyle(keyword).color,comment:comment&&getComputedStyle(comment).color,commentStyle:comment&&getComputedStyle(comment).fontStyle,background:getComputedStyle(pane.querySelector('.monaco-editor')).backgroundColor};})()`,
      );
    const dark = await until(async () => {
      const colors = await renderedPalette();
      return (
        colors.keyword &&
        colors.comment &&
        colors.commentStyle === "italic" &&
        colors
      );
    }, "dark themed tokens rendered");
    assert.notEqual(
      dark.keyword,
      dark.comment,
      "syntax roles have distinct foregrounds",
    );
    assert.equal(
      dark.commentStyle,
      "italic",
      "shared comment styling applies to TextMate tokens",
    );
    await screenshot("syntax-dark-1440.png");
    await evaluate(`document.querySelector('button').click()`);
    const light = await until(async () => {
      const colors = await renderedPalette();
      return (
        colors.keyword !== dark.keyword &&
        colors.background !== dark.background &&
        colors.commentStyle === "italic" &&
        colors
      );
    }, "light theme updates existing tokenized models");
    assert.equal(light.commentStyle, "italic");
    await screenshot("syntax-light-1440.png");
    await dimensions(860, 620);
    await pause(250);
    const geometry = await evaluate(
      `window.__syntaxFixture.monaco.editor.getEditors().map(editor=>({width:editor.getLayoutInfo().width,container:editor.getContainerDomNode().closest('.gyro-syntax-editor').clientWidth,height:editor.getLayoutInfo().height}))`,
    );
    assert.ok(
      geometry.every(
        (pane) => pane.width <= pane.container + 1 && pane.height > 120,
      ),
      "four narrow panes stay inside their containers",
    );
    await screenshot("syntax-light-860.png");
    await evaluate(`document.querySelector('button').click()`);
    await until(async () => {
      const colors = await renderedPalette();
      return (
        colors.keyword === dark.keyword && colors.commentStyle === "italic"
      );
    }, "dark theme restored");
    await screenshot("syntax-dark-860.png");
    // Once local assets are installed, editing and retokenization need no network.
    await call("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    const edited = await evaluate(
      `(()=>{const f=window.__syntaxFixture;const path='/syntax/Welcome.vue';const model=f.model(path);model.applyEdits([{range:{startLineNumber:2,startColumn:1,endLineNumber:4,endColumn:1},text:'/* closed comment */\\nconst edited = "offline";\\n'}]);return f.tokenization(path,model.getValue());})()`,
    );
    assert.equal(
      roleAt(
        {
          ...edited,
          content: await evaluate(
            `window.__syntaxFixture.model('/syntax/Welcome.vue').getValue()`,
          ),
        },
        3,
        "const",
      ),
      "storageKeyword",
      "closing comment retokenizes next line while offline",
    );
    await until(
      () =>
        evaluate(
          `document.querySelector('[data-path="/syntax/Welcome.vue"] .view-lines').textContent.includes('offline')`,
        ),
      "offline model edit rendered",
    );
    await writeFile(
      join(artifacts, "network.json"),
      JSON.stringify({ origin, requests, blocked, faults }, null, 2),
    );
    await writeFile(
      join(artifacts, "browser-errors.json"),
      JSON.stringify(errors, null, 2),
    );
    assert.equal(blocked.length, 0, "all cold-load assets are bundled locally");
    assert.ok(
      requests.some((url) => /\.wasm(?:$|\?)/.test(url)),
      "Oniguruma WASM loaded as a local asset",
    );
    assert.ok(
      requests.every(
        (url) =>
          url.startsWith(origin + "/") ||
          url.startsWith("data:") ||
          url.startsWith("blob:"),
      ),
      "no remote dependency requests",
    );
    // Reopening a retained plain-text model with an already loaded grammar must
    // attach the current language even when the React adapter mounts later.
    await evaluate(
      `(()=>{const f=window.__syntaxFixture;window.__warmSyntaxModel=f.model('/syntax/Welcome.vue');f.monaco.editor.setModelLanguage(window.__warmSyntaxModel,'plaintext');f.remountPanes();})()`,
    );
    await until(
      () =>
        evaluate(
          `window.__syntaxFixture.model('/syntax/Welcome.vue')?.getLanguageId()==='gyro-tm-vue'`,
        ),
      "warm grammar mount updates retained plain-text model",
    );
    assert.equal(
      await evaluate(
        `window.__syntaxFixture.model('/syntax/Welcome.vue')===window.__warmSyntaxModel`,
      ),
      true,
      "warm grammar mount preserves the shared model",
    );
    await writeFile(
      join(artifacts, "browser-errors.json"),
      JSON.stringify(errors, null, 2),
    );
    assert.equal(errors.length, 0, "no browser exceptions");
    console.log(
      `Workspace syntax browser checks passed: four real bundled grammars, multiline state, embedded TypeScript/CSS/SCSS, no LSP, local-only cold load, offline edits and both themes at1440/860. Screenshots: ${artifacts}`,
    );
  }
} catch (error) {
  console.error("Workspace syntax browser failure:", error);
  if (failureSnapshot)
    console.error("Syntax browser state:", await failureSnapshot());
  throw error;
} finally {
  socket?.close();
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
