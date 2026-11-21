import assert from "node:assert/strict";
import ts from "typescript";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Production ChatRun, simulated events, an isolated headless browser.
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1439";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const fixture = new URL("/command-failure-fixture.html", origin);
const response = await fetch(fixture, { signal: AbortSignal.timeout(5_000) });
assert.equal(
  response.status,
  200,
  "Start the desktop Vite preview before running this check",
);
const executable = [
  process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
].find((path) => path && existsSync(path));
assert.ok(
  executable,
  "Set GYRO_CAPTURE_BROWSER to an installed Chromium browser",
);
const profile = await mkdtemp(join(tmpdir(), "gyro-chat-reliability-"));
const output = resolve("artifacts/screenshots/chat-session-reliability");
await mkdir(output, { recursive: true });
const browser = spawn(
  executable,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--user-data-dir=" + profile,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let launchError;
browser.once("error", (error) => {
  launchError = error;
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null)
      throw Error("Browser exited with " + browser.exitCode);
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw Error("Timed out: " + label);
}

const surfaceSource = await readFile(
  new URL("../packages/ui/src/surfaces.tsx", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "surfaces.tsx",
  surfaceSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const notice = tree.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "FailureNotice",
);
assert.ok(notice, "Production load-failure notice exists");
const noticeJs = ts.transpileModule(notice.getText(tree), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

const answerText =
  "Use `System.Text.Json`.\n\n```python\ndef answer():\n\n    return 7\n```\n\nThe result is:\n\n7\n\nThat is the count.";
const uiRoot = new URL("../packages/ui/src/", import.meta.url).pathname;
let socket;
const results = [];
const pageErrors = [];
try {
  const port = await until(async () => {
    const path = join(profile, "DevToolsActivePort");
    return (
      existsSync(path) && Number((await readFile(path, "utf8")).split("\n")[0])
    );
  }, "browser startup");
  const pages = await (
    await fetch("http://127.0.0.1:" + port + "/json/list")
  ).json();
  socket = new WebSocket(
    pages.find((page) => page.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      pageErrors.push(message.params.exceptionDetails);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    message.error
      ? call.reject(Error(message.error.message))
      : call.resolve(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(method));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"])
      await call("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode,
        ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
      });
  };
  await call("Page.enable");
  await call("Runtime.enable");

  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await call("Page.navigate", { url: fixture + "?theme=" + theme });
      await until(
        () => evaluate('!!document.querySelector("main")'),
        "fixture",
      );
      await evaluate(`(async () => {
        const {default:React} = await import('/node_modules/.vite/deps/react.js'); const {useState}=React;
        const {default:ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js'); const {createRoot}=ReactDOM;
        const {TriangleAlert,X} = await import('/node_modules/.vite/deps/lucide-react.js');
        const {ChatRun,ChatSurface,ChatThread,SettingsSurface} = await import('/@fs${uiRoot}index.ts');
        const {buildRunModel} = await import('/@fs${uiRoot}chat-run.ts');
        ${noticeJs}
        document.getElementById('root').hidden=true;
        const host=document.createElement('main');host.id='reliability';document.body.append(host);
        host.style.cssText='padding:var(--gyro-space-panel);background:var(--gyro-surface);color:var(--gyro-text);min-height:100vh';
        window.fixtureRoot=createRoot(host);
        window.retryCalls=0;
        window.showNotice=()=>window.fixtureRoot.render(React.createElement(FailureNotice,{
          notification:{id:'load-error',title:'Could not load chats',detail:'Fixture storage failure',correlationKey:'session-list-load'},
          onRetry:()=>{window.retryCalls++;return new Promise(resolve=>window.finishRetry=resolve)}
        }));
        const event=(id,kind,message,payload)=>({id,sessionId:'fixture',turnId:'turn',createdAt:'2026-11-17T10:00:00Z',kind,message,payload});
        window.showCapabilityApproval = (outcome) => {
          const approvalId = 'web-fetch-approval';
          const callId = 'web-fetch-call';
          const events = [
            event('user', 'user-message', 'Fetch the release notes', {}),
            event('pending', 'approval-requested', 'Allow web fetch?', {
              schema: 'gyro.capability.v1', kind: 'capability-approval',
              approvalId, callId, status: 'waiting', capabilityId: 'web-fetch',
              capabilityClass: 'browser-navigate', scopeKind: 'origin', scopeValue: 'https://example.com',
              choices: ['deny', 'allow-once', 'allow-project'],
            }),
          ];
          const render = (sessionEvents) => window.fixtureRoot.render(React.createElement(ChatSurface, {
            config: {
              commandProfiles: [], modelProviders: [], requireCommandApproval: true,
              requireFileEditApproval: true, telemetryEnabled: false,
            },
            events: sessionEvents, isComposerSending: outcome !== 'interrupted', onSend: () => {},
            onProviderApprovalAction: (id, decision) => {
              window.capabilityDecision = { id, decision };
              render([...events, event('decision', 'system-event', 'Capability approval ' + outcome, {
                kind: 'capability-approval', approvalId, callId, status: outcome,
              })]);
            },
          }));
          render(outcome === 'interrupted' ? [
            ...events,
            event('recovered', 'system-event', 'Interrupted', {
              kind: 'provider-status', status: 'failed', recoveryKind: 'interrupted',
            }),
          ] : events);
        };
        window.showSitePermissions = () => {
          const workspacePath = '/fixture-project';
          const policy = {
            workspaceKey: workspacePath, revision: 1,
            grants: [{ id: 'permission', class: 'browser-navigate',
              scopeKind: 'origin', scopeValue: 'https://search.brave.com' }],
          };
          window.siteRevokeCalls = 0;
          window.fixtureRoot.render(React.createElement(SettingsSurface, {
            activeSection: 'permissions',
            themeMode: document.documentElement.dataset.theme,
            config: { commandProfiles: [], modelProviders: [], requireCommandApproval: true,
              requireFileEditApproval: true, telemetryEnabled: false },
            onThemeChange: () => {},
            projectSitePermissions: {
              workspacePath,
              load: async () => policy,
              revoke: async (path, prior, id) => {
                window.siteRevokeCalls++;
                if (path !== workspacePath || id !== 'permission' || prior.revision !== policy.revision)
                  throw Error('Wrong permission scope');
                if (window.siteRevokeCalls === 1) throw Error('Permission list changed');
                return { ...policy, revision: 2, grants: [] };
              },
            },
          }));
        };
        window.showAnswer=()=>window.fixtureRoot.render(React.createElement(ChatThread,{
          events:[event('user','user-message','Show the result',{}),event('reply','assistant-message',
            ${JSON.stringify(answerText)},{kind:'provider-response'}),
            event('done','system-event','Done',{kind:'provider-status',status:'done'})],
          terminalPanes:[],draft:'',onDraftChange:()=>{},onSend:()=>{}
        }));
        window.showInterrupted=()=>window.fixtureRoot.render(React.createElement('section',{className:'gyro-chat-surface is-thread',style:{height:'auto',overflow:'visible'}},React.createElement('div',{className:'gyro-chat-turn'},React.createElement('div',{className:'gyro-chat-run'},React.createElement(ChatRun,{
          model:buildRunModel([event('tool','system-event','Running tests',{kind:'provider-activity',activityKind:'command',activityId:'cmd',command:'npm test',status:'running'})],{status:{status:'cancelled'},isRunning:false}),
          suppressThinkingIndicator:true
        })))));
        window.showNotice();
      })()`);
      await until(
        () =>
          evaluate(
            'document.querySelector("#reliability button")?.textContent === "Retry"',
          ),
        "retry action",
      );
      await key("Tab", "Tab", 9);
      assert.equal(
        await evaluate("document.activeElement.textContent"),
        "Retry",
      );
      const focus = await evaluate(
        "({style:getComputedStyle(document.activeElement).outlineStyle,width:getComputedStyle(document.activeElement).outlineWidth})",
      );
      assert.notEqual(focus.style, "none");
      assert.ok(parseFloat(focus.width) >= 1);
      await key("Enter", "Enter", 13);
      await until(
        () =>
          evaluate(
            'window.retryCalls===1 && document.querySelector("#reliability button").disabled',
          ),
        "retry in flight",
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#reliability button").textContent',
        ),
        "Retrying…",
      );
      await evaluate("window.finishRetry()");
      await until(
        () =>
          evaluate('!document.querySelector("#reliability button").disabled'),
        "retry settled",
      );
      let shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(output, `${theme}-${width}-retry.png`),
        Buffer.from(shot.data, "base64"),
      );
      await evaluate("window.showAnswer()");
      await until(
        () => evaluate('!!document.querySelector("#reliability pre")'),
        "code answer",
      );
      const code = (
        await evaluate(
          'Array.from(document.querySelectorAll("#reliability pre"),n=>n.textContent)',
        )
      ).join("\n");
      assert.match(code, /def answer\(\):\n\n    return 7/);
      const answer = await evaluate(
        'document.querySelector("#reliability").innerText',
      );
      assert.match(answer, /System\.Text\.Json/);
      assert.match(answer, /The result is:\s+7\s+That is the count/);
      shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(output, `${theme}-${width}-answer.png`),
        Buffer.from(shot.data, "base64"),
      );
      await evaluate("window.showInterrupted()");
      await until(
        () =>
          evaluate(
            'document.querySelector("#reliability").innerText.includes("Interrupted")',
          ),
        "interrupted tool label",
      );
      assert.doesNotMatch(
        await evaluate('document.querySelector("#reliability").innerText'),
        /Ran tests/,
      );
      assert.equal(
        await evaluate("document.documentElement.scrollWidth > innerWidth"),
        false,
        "no viewport overflow",
      );
      shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(output, `${theme}-${width}-interrupted.png`),
        Buffer.from(shot.data, "base64"),
      );
      for (const [label, decision, outcome, statusLabel] of [
        ["Allow for project", "allow-project", "approved", "Approved"],
        ["Allow for this chat", "approve", "approved", "Approved"],
        ["Reject", "reject", "rejected", "Rejected"],
      ]) {
        await evaluate(`window.showCapabilityApproval(${JSON.stringify(outcome)})`);
        const selector = "#reliability .gyro-inline-approval";
        await until(() => evaluate(
          `document.querySelector('${selector}.is-pending [role="status"]')?.textContent === "Waiting for your approval"`,
        ), "web fetch awaiting approval");
        assert.equal(await evaluate(`(() => {
          const button = Array.from(document.querySelectorAll('${selector} button'))
            .find((button) => button.textContent === ${JSON.stringify(label)});
          button?.focus();
          return button === document.activeElement;
        })()`), true);
        await key("Enter", "Enter", 13);
        assert.deepEqual(await evaluate("window.capabilityDecision"), {
          id: "web-fetch-approval", decision,
        });
        await until(() => evaluate(
          `document.querySelector('${selector}.is-${outcome} [role="status"]')?.textContent === ${JSON.stringify(statusLabel)}`,
        ), "web fetch approval settled");
        assert.equal(await evaluate(`document.querySelectorAll('${selector} button').length`), 0);
        assert.doesNotMatch(await evaluate('document.querySelector("#reliability").innerText'),
          /Needs approval|Waiting for your approval|Capability approval (approved|rejected)/);
      }
      await evaluate("window.showCapabilityApproval('interrupted')");
      await until(() => evaluate(
        'document.querySelector("#reliability .gyro-inline-approval.is-cancelled [role=status]")?.textContent === "Cancelled"',
      ), "interrupted approval cancelled");
      assert.doesNotMatch(await evaluate('document.querySelector("#reliability").innerText'),
        /Needs approval|Waiting for your approval|Allow for this chat/);

      await evaluate("window.showSitePermissions()");
      const revokeSelector = '#reliability button[aria-label="Revoke site permission for https://search.brave.com"]';
      await until(() => evaluate(
        `!!document.querySelector(${JSON.stringify(revokeSelector)})`,
      ), "saved site shown");
      const focusRevoke = () => evaluate(
        `document.querySelector(${JSON.stringify(revokeSelector)}).focus()`,
      );
      await focusRevoke();
      shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(output, `${theme}-${width}-saved-sites.png`),
        Buffer.from(shot.data, "base64"),
      );
      await key("Enter", "Enter", 13);
      await until(() => evaluate(
        'document.querySelector("#reliability").innerText.includes("Permission list changed")',
      ), "revoke error presented");
      await evaluate(
        'Array.from(document.querySelectorAll("#reliability button")).find(button => button.textContent === "Reload").focus()',
      );
      await key("Enter", "Enter", 13);
      await until(() => evaluate(
        `document.querySelector(${JSON.stringify(revokeSelector)})?.disabled === false`,
      ), "saved sites reloaded");
      await focusRevoke();
      await key("Enter", "Enter", 13);
      await until(() => evaluate(
        'document.querySelector("#reliability").innerText.includes("No saved sites")',
      ), "site permission revoked");
      assert.equal(await evaluate("window.siteRevokeCalls"), 2);
      results.push({
        theme,
        width,
        retryKeyboard: true,
        answerFidelity: true,
        interruptedTool: true,
        capabilityApproval: true,
        interruptedApproval: true,
        sitePermissionRevocation: true,
      });
    }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(
    "Chat reliability browser checks passed: Retry keyboard/focus and pending state, code/number fidelity, interrupted labels, capability approval decisions, restart recovery, and site permission revocation; light/dark at 390/1280px.",
  );
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => browser.once("exit", resolve)),
    pause(2_000),
  ]);
  if (browser.exitCode !== null || browser.signalCode !== null)
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
}
