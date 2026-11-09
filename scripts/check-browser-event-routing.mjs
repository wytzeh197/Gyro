import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";
import { createSessionBrowserQueue } from "../apps/desktop/src/session-browser-queue.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";
import {
  isSplitChatLayout,
  resolveBrowserReveal,
} from "../packages/ui/src/browser-reveal.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const viewport = {
  mode: "mobile",
  device: "mobile",
  width: 390,
  height: 844,
  scale: 1,
};
const snapshot = (resourceId = "new", sessionId = "chat") => ({
  sessionId,
  resourceId,
  url: `https://${resourceId}.example/`,
  title: `Page ${resourceId}`,
  loading: false,
  navigationId: 1,
  viewport,
});

function appCallback(name, dependencies) {
  const source = readFileSync(
    new URL("../apps/desktop/src/App.tsx", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "App.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let declaration;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name)
      declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(declaration, `App callback ${name} missing`);
  const fragment = declaration.parent.parent.getText(parsed);
  const code = ts.transpileModule(`${fragment}\nexports.callback = ${name};`, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(
    code,
    { ...dependencies, exports },
    { filename: `App.${name}.ts` },
  );
  return exports.callback;
}

function harness(invoke = async () => snapshot()) {
  const listeners = new Map();
  const cleanup = [];
  const calls = [];
  const bridge = createSessionBrowserQueue(async (command, args) => {
    calls.push([command, args]);
    return invoke(command, args);
  });
  let state = createInitialWorkbenchState();
  let dispatchCount = 0;
  const dispatch = (action) => {
    dispatchCount++;
    state = workbenchReducer(state, action);
  };
  // Execute the actual hooks, removing only TypeScript and imports. The native
  // transport and React lifecycle are controlled; the reducer is production code.
  const dependencies = {
    react: {
      useEffect: (effect) => cleanup.push(effect()),
      useRef: (current) => ({ current }),
    },
    "@tauri-apps/api/core": { invoke, isTauri: () => true },
    "@tauri-apps/api/event": {
      listen: async (name, handler) => {
        listeners.set(name, handler);
        return () => listeners.delete(name);
      },
    },
    "@gyro-dev/ui": { isSplitChatLayout, resolveBrowserReveal },
    "./session-browser-native": { sessionBrowserNative: bridge },
  };
  const load = (file) => {
    const source =
      process.env.GYRO_BROWSER_EVENT_BASELINE === "1"
        ? execFileSync("git", ["show", `HEAD:apps/desktop/src/${file}`], {
            encoding: "utf8",
            cwd: new URL("..", import.meta.url),
          })
        : readFileSync(
            new URL(`../apps/desktop/src/${file}`, import.meta.url),
            "utf8",
          );
    const code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(
      code,
      {
        module,
        exports: module.exports,
        require: (name) => {
          assert.ok(dependencies[name], `unexpected hook dependency ${name}`);
          return dependencies[name];
        },
      },
      { filename: file },
    );
    return module.exports;
  };
  const browserEvents = load("use-session-browser-events.ts");
  browserEvents.useSessionBrowserEvents(dispatch);
  load("model-browser-reveal.ts").useModelBrowserReveal({
    activeSessionId: "chat",
    dispatch,
    hasMaximizedPane: false,
    isBrowserVisible: false,
    isTauriRuntime: true,
    occupiedPaneCount: 2,
  });
  return {
    bridge,
    calls,
    dispatch,
    dispatchCount: () => dispatchCount,
    changeViewport: (mode, hasPage, onError) =>
      browserEvents.changeSessionBrowserViewport(
        "chat",
        mode,
        hasPage,
        dispatch,
        onError,
      ),
    capture: (operation, attached, notices) =>
      appCallback("captureBrowserPreview", {
        useCallback: (fn) => fn,
        activeBrowserOwner: { sessionId: "chat", draftKey: "chat" },
        previewForBrowser: () =>
          state.browserPreviewsBySession?.chat ?? state.browserPreview,
        sendBrowserAction: (owner, action) =>
          dispatch({
            type: "browser-session",
            sessionId: owner.sessionId,
            action,
          }),
        sessionBrowserNative: bridge,
        captureChatBrowserPage: operation,
        attachBrowserCaptureToChat: async (capture) => attached.push(capture),
        chatAttachments: {},
        workbench: {},
        notify: (...args) => notices.push(args),
      }),
    state: () => state,
    emit: (name, payload) => listeners.get(name)?.({ payload }),
    drain: (sessionId = "chat") =>
      bridge.run(
        sessionId,
        async () => undefined,
        () => {},
        (error) => {
          throw error;
        },
      ),
    dispose: () => cleanup.forEach((stop) => stop?.()),
  };
}

const cases = [];
const measurements = {};
async function check(name, run) {
  await run();
  cases.push(name);
}

await check(
  "old or untagged events cannot change a reopened browser or reveal its panel",
  async () => {
    const h = harness();
    const before = h.state();
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "old",
      kind: "loaded",
      url: "https://wrong.example/",
    });
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "old",
      kind: "title",
      title: "wrong",
    });
    h.emit("session-browser-opened", {
      sessionId: "chat",
      resourceId: "old",
      url: "https://wrong.example/",
      reveal: true,
    });
    h.emit("session-browser-event", {
      sessionId: "chat",
      kind: "viewport",
      viewport,
    });
    await h.drain();
    assert.ok(
      h.state() === before,
      "a stale browser event changed the current UI or revealed its panel",
    );
    assert.equal(h.calls.length, 3);
    h.dispose();
  },
);

await check(
  "valid loaded/title/viewport events use current native values",
  async () => {
    const h = harness();
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "new",
      kind: "loaded",
      url: "https://stale.example/",
    });
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "new",
      kind: "title",
      title: "stale title",
    });
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "new",
      kind: "viewport",
      viewport: { width: 1 },
    });
    await h.drain();
    const preview = h.state().browserPreviewsBySession.chat;
    assert.equal(preview.url, snapshot().url);
    assert.equal(preview.title, snapshot().title);
    assert.equal(preview.viewport, viewport);
    assert.equal(preview.status, "ready");
    assert.equal(h.state().preferences.activeChatPanel, undefined);
    h.dispose();
  },
);

await check(
  "opening a model browser does not claim a pending page is ready",
  async () => {
    const pending = { ...snapshot(), loading: true };
    const h = harness(async () => pending);
    h.emit("session-browser-opened", {
      sessionId: "chat",
      resourceId: "new",
      url: pending.url,
      reveal: true,
    });
    await h.drain();
    assert.equal(h.state().browserPreviewsBySession.chat.status, "loading");
    assert.equal(h.state().preferences.activeChatPanel, "browser");
    h.dispose();
  },
);

await check(
  "old loaded notifications cannot finish a newer navigation in the same browser",
  async () => {
    let current = snapshot();
    const h = harness(async () => current);
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "new",
      kind: "loaded",
    });
    await h.drain();
    current = {
      ...snapshot(),
      url: "https://next.example/",
      title: "Next",
      navigationId: 2,
      loading: true,
    };
    // The event was queued by the previous page. Its resource still matches.
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "new",
      kind: "loaded",
      url: snapshot().url,
    });
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "new",
      kind: "title",
    });
    await h.drain();
    let preview = h.state().browserPreviewsBySession.chat;
    assert.equal(preview.status, "loading");
    assert.equal(preview.url, current.url);
    assert.equal(preview.title, "Next");
    current = {
      ...current,
      url: "https://next.example/redirect",
      loading: false,
    };
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "new",
      kind: "loaded",
    });
    await h.drain();
    preview = h.state().browserPreviewsBySession.chat;
    assert.equal(preview.status, "ready");
    assert.deepEqual(preview.history, [snapshot().url, current.url]);
    assert.equal(h.state().preferences.activeChatPanel, undefined);
    h.dispose();
  },
);

await check(
  "native failure and cancelled loads settle truthfully and clear after recovery",
  async () => {
    let current = snapshot();
    const h = harness(async () => current);
    const event = (kind) => h.emit("session-browser-event",{sessionId:"chat",resourceId:"new",kind});
    event("loaded");
    await h.drain();
    for (const kind of ["failed","cancelled"]) {
      current={...current,url:`https://${kind}.example/`,navigationId:current.navigationId+1,loading:true,navigationError:null};
      event("loading");
      await h.drain();
      h.dispatch({type:"browser-session",sessionId:"chat",action:{type:"browser-capture-success",capture:{filename:"partial.png",path:"/tmp/partial.png",width:390,height:844,createdAt:"2026-11-07T00:00:00Z"}}});
      current={...current,loading:false,navigationError:{kind,message:`Navigation ${kind}. Try again.`,code:kind==="cancelled"?-999:-1005}};
      event("failed");
      await h.drain();
      let preview=h.state().browserPreviewsBySession.chat;
      assert.equal(preview.status,"verification-failed");
      assert.equal(preview.nativeLoading,false);
      assert.equal(preview.latestCapture,undefined);
      assert.equal(preview.verificationMessage,current.navigationError.message);
      // A stale loaded notification observes the current failure, not old success.
      event("loaded");
      await h.drain();
      assert.equal(h.state().browserPreviewsBySession.chat.status,"verification-failed");
      current={...current,navigationId:current.navigationId+1,loading:false,navigationError:null};
      event("loaded");
      await h.drain();
      preview=h.state().browserPreviewsBySession.chat;
      assert.equal(preview.status,"ready");
      assert.equal(preview.navigationError,undefined);
    }
    assert.equal(h.state().preferences.activeChatPanel,undefined);
    h.dispose();
  },
);

await check(
  "native reload clears its old capture without duplicating history or revealing a panel",
  async () => {
    let current = snapshot();
    const h = harness(async () => current);
    const event = (kind) =>
      h.emit("session-browser-event", {
        sessionId: "chat",
        resourceId: "new",
        kind,
      });
    event("loaded");
    await h.drain();
    const capture = {
      filename: "before.png",
      path: "/tmp/before.png",
      width: 390,
      height: 844,
      createdAt: "2026-11-07T00:00:00Z",
    };
    h.dispatch({
      type: "browser-session",
      sessionId: "chat",
      action: { type: "browser-capture-success", capture },
    });
    current = { ...current, loading: true, navigationId: 2, title: "" };
    event("loading");
    await h.drain();
    const pending = h.state().browserPreviewsBySession.chat;
    assert.equal(pending.status, "loading");
    assert.equal(pending.latestCapture, undefined);
    assert.equal(pending.title, undefined);
    current = { ...current, loading: false, title: "Reloaded" };
    event("loaded");
    await h.drain();
    const preview = h.state().browserPreviewsBySession.chat;
    assert.equal(preview.status, "ready");
    assert.deepEqual(preview.history, [current.url]);
    assert.equal(h.state().preferences.activeChatPanel, undefined);
    h.dispose();
  },
);

await check(
  "a queued finished snapshot cannot undo Back before WebKit starts the history request",
  async () => {
    let current = snapshot();
    const h = harness(async () => current);
    const event = (kind) =>
      h.emit("session-browser-event", {
        sessionId: "chat",
        resourceId: "new",
        kind,
      });
    event("loaded");
    await h.drain();
    current = { ...current, url: "https://second.example/", navigationId: 2 };
    event("loaded");
    await h.drain();
    h.dispatch({
      type: "browser-session",
      sessionId: "chat",
      action: { type: "browser-back" },
    });
    event("title");
    await h.drain();
    let preview = h.state().browserPreviewsBySession.chat;
    assert.equal(preview.status, "loading");
    assert.equal(preview.url, snapshot().url);
    assert.equal(preview.historyIndex, 0);
    assert.deepEqual(preview.history, [snapshot().url, current.url]);
    current = {
      ...current,
      url: snapshot().url,
      navigationId: 3,
      loading: true,
    };
    event("loading");
    await h.drain();
    current = { ...current, loading: false };
    event("loaded");
    await h.drain();
    preview = h.state().browserPreviewsBySession.chat;
    assert.equal(preview.status, "ready");
    assert.equal(preview.historyIndex, 0);
    assert.deepEqual(preview.history, [
      snapshot().url,
      "https://second.example/",
    ]);
    h.dispose();
  },
);

await check(
  "model reveal keeps its policy and uses current native metadata",
  async () => {
    const h = harness(async (_command, { sessionId }) =>
      snapshot("new", sessionId),
    );
    h.emit("session-browser-opened", {
      sessionId: "other",
      resourceId: "new",
      url: "https://stale.example/",
      reveal: true,
    });
    await h.drain("other");
    assert.equal(h.state().preferences.activeChatPanel, undefined);
    h.emit("session-browser-opened", {
      sessionId: "chat",
      resourceId: "new",
      url: "https://stale.example/",
    });
    await h.drain();
    assert.equal(h.state().preferences.activeChatPanel, undefined);
    h.emit("session-browser-opened", {
      sessionId: "chat",
      resourceId: "new",
      url: "https://stale.example/",
      reveal: true,
    });
    await h.drain();
    assert.equal(h.state().preferences.activeChatPanel, "browser");
    assert.equal(h.state().browserPreviewsBySession.chat.url, snapshot().url);
    assert.equal(
      h.state().browserPreviewsBySession.chat.title,
      snapshot().title,
    );
    h.dispose();
  },
);

for (const kind of ["loaded", "opened"]) {
  await check(
    `close invalidates an in-flight ${kind} snapshot before dispatch`,
    async () => {
      const started = deferred(),
        result = deferred();
      const h = harness(async (command) => {
        if (command === "session_browser_snapshot") {
          started.resolve();
          return result.promise;
        }
        return null;
      });
      h.emit(
        kind === "opened" ? "session-browser-opened" : "session-browser-event",
        { sessionId: "chat", resourceId: "old", kind, reveal: true },
      );
      await started.promise;
      const closed = h.bridge.close("chat", assert.fail);
      h.dispatch({
        type: "browser-session",
        sessionId: "chat",
        action: { type: "browser-close" },
      });
      const afterClose = h.state();
      result.resolve(snapshot("old"));
      assert.equal(await closed, true);
      await h.drain();
      assert.equal(h.state(), afterClose);
      assert.equal(h.state().browserPreviewsBySession.chat.url, "");
      assert.equal(h.state().preferences.activeChatPanel, undefined);
      h.dispose();
    },
  );
}

await check(
  "in-flight open, close and reopen execute in order without stale success",
  async () => {
    const started = deferred(),
      first = deferred();
    const order = [],
      successes = [],
      failures = [];
    const bridge = createSessionBrowserQueue(async (command) => {
      order.push(command);
      return null;
    });
    const oldOpen = bridge.replace(
      "chat",
      async () => {
        order.push("open-old");
        started.resolve();
        return first.promise;
      },
      (value) => successes.push(value),
      (error) => failures.push(error),
    );
    await started.promise;
    const close = bridge.close("chat", (error) => failures.push(error));
    const reopen = bridge.replace(
      "chat",
      async () => {
        order.push("open-new");
        return snapshot();
      },
      (value) => successes.push(value),
      (error) => failures.push(error),
    );
    first.resolve(snapshot("old"));
    assert.deepEqual(await Promise.all([oldOpen, close, reopen]), [
      false,
      true,
      true,
    ]);
    assert.deepEqual(order, ["open-old", "session_browser_close", "open-new"]);
    assert.deepEqual(successes, [snapshot()]);
    assert.deepEqual(failures, []);
  },
);

await check(
  "late failures stay with their owner and do not poison a reopen",
  async () => {
    const started = deferred(),
      first = deferred();
    const failures = [],
      successes = [];
    const bridge = createSessionBrowserQueue(async () => null);
    const old = bridge.replace(
      "chat",
      async () => {
        started.resolve();
        return first.promise;
      },
      assert.fail,
      (error) => failures.push(error),
    );
    await started.promise;
    const close = bridge.close("chat", assert.fail);
    const next = bridge.replace(
      "chat",
      async () => "new",
      (value) => successes.push(value),
      assert.fail,
    );
    first.reject(new Error("old failure"));
    await Promise.all([old, close, next]);
    assert.deepEqual(failures, []);
    assert.deepEqual(successes, ["new"]);
    await bridge.run(
      "chat",
      async () => {
        throw new Error("current failure");
      },
      assert.fail,
      (error) => failures.push(error.message),
    );
    await bridge.run(
      "chat",
      async () => "recovered",
      (value) => successes.push(value),
      assert.fail,
    );
    assert.deepEqual(failures, ["current failure"]);
    assert.deepEqual(successes, ["new", "recovered"]);
  },
);

await check(
  "a slow browser does not block another chat's native events",
  async () => {
    const started = deferred(),
      first = deferred();
    const h = harness(async (_command, { sessionId }) => {
      if (sessionId === "slow") {
        started.resolve();
        return first.promise;
      }
      return snapshot("new", sessionId);
    });
    h.emit("session-browser-event", {
      sessionId: "slow",
      resourceId: "new",
      kind: "loaded",
    });
    await started.promise;
    h.emit("session-browser-event", {
      sessionId: "chat",
      resourceId: "new",
      kind: "loaded",
    });
    await h.drain();
    assert.equal(h.state().browserPreviewsBySession.chat.status, "ready");
    assert.equal(h.state().browserPreviewsBySession.slow, undefined);
    first.resolve(snapshot("new", "slow"));
    await h.drain("slow");
    assert.equal(h.state().browserPreviewsBySession.slow.status, "ready");
    h.dispose();
  },
);

await check(
  "a burst of queued titles reads and dispatches only the latest snapshot",
  async () => {
    const h = harness();
    for (let index = 0; index < 1000; index++) {
      h.emit("session-browser-event", {
        sessionId: "chat",
        resourceId: "new",
        kind: "title",
        title: `queued ${index}`,
      });
    }
    await h.drain();
    assert.equal(h.calls.length, 1);
    assert.equal(h.dispatchCount(), 1);
    assert.equal(
      h.state().browserPreviewsBySession.chat.title,
      snapshot().title,
    );
    measurements.titleBurst = {
      inputEvents: 1000,
      nativeSnapshotReads: 1,
      dispatchedWorkbenchActions: 1,
    };
    h.dispose();
  },
);

await check(
  "unmount suppresses a snapshot that was already requested",
  async () => {
    const started = deferred(),
      result = deferred();
    const h = harness(async () => {
      started.resolve();
      return result.promise;
    });
    const before = h.state();
    h.emit("session-browser-opened", {
      sessionId: "chat",
      resourceId: "new",
      reveal: true,
    });
    await started.promise;
    h.dispose();
    result.resolve(snapshot());
    await h.drain();
    assert.equal(h.state(), before);
  },
);

await check(
  "missing and wrong-session snapshots cannot supply an event",
  async () => {
    for (const value of [null, snapshot("new", "other")]) {
      const bridge = createSessionBrowserQueue(async () => value);
      assert.equal(
        await bridge.observe("chat", "new", "title", assert.fail),
        false,
      );
    }
  },
);

await check(
  "close and reopen do not wait for a stuck observation or ordinary command",
  async () => {
    for (const operation of ["observation", "command"]) {
      const started = deferred(),
        blocked = deferred();
      let reads = 0;
      const h = harness(async (command) => {
        if (
          command === "session_browser_snapshot" &&
          reads++ === 0 &&
          operation === "observation"
        ) {
          started.resolve();
          return blocked.promise;
        }
        return command === "session_browser_snapshot" ? snapshot() : null;
      });
      const oldWork =
        operation === "command"
          ? h.bridge.run(
              "chat",
              async () => {
                started.resolve();
                return blocked.promise;
              },
              assert.fail,
              assert.fail,
            )
          : h.bridge.observe("chat", "old", "title", assert.fail);
      await started.promise;
      let timer;
      try {
        const closing = h.bridge.close("chat", assert.fail);
        const reopening = h.bridge.replace(
          "chat",
          async () => snapshot(),
          () => {},
          assert.fail,
        );
        await Promise.race([
          Promise.all([closing, reopening]),
          new Promise((_, fail) => {
            timer = setTimeout(
              () => fail(new Error(`${operation} blocked Close/reopen`)),
              1000,
            );
          }),
        ]);
        h.emit("session-browser-event", {
          sessionId: "chat",
          resourceId: "new",
          kind: "loaded",
        });
        await Promise.race([
          h.drain(),
          new Promise((_, fail) => {
            clearTimeout(timer);
            timer = setTimeout(
              () =>
                fail(
                  new Error(`${operation} blocked the replacement's events`),
                ),
              1000,
            );
          }),
        ]);
        assert.equal(h.state().browserPreviewsBySession.chat.status, "ready");
      } finally {
        clearTimeout(timer);
        blocked.resolve(snapshot("old"));
        await oldWork;
        h.dispose();
      }
    }
  },
);

await check(
  "viewport results and failures remain bound to the browser lifetime",
  async () => {
    const started = deferred(),
      result = deferred();
    const errors = [];
    let fail = false;
    const h = harness(async (command) => {
      if (command === "session_browser_set_viewport") {
        if (fail) throw new Error("viewport rejected");
        started.resolve();
        return result.promise;
      }
      return null;
    });
    const change = h.changeViewport("mobile", true, (error) =>
      errors.push(error.message),
    );
    await started.promise;
    const closing = h.bridge.close("chat", assert.fail);
    h.dispatch({
      type: "browser-session",
      sessionId: "chat",
      action: { type: "browser-close" },
    });
    const afterClose = h.state();
    result.resolve({ viewport });
    await Promise.all([change, closing]);
    assert.equal(h.state(), afterClose);
    assert.deepEqual(errors, []);
    fail = true;
    await h.changeViewport("mobile", true, (error) =>
      errors.push(error.message),
    );
    assert.deepEqual(errors, ["viewport rejected"]);
    await h.changeViewport("mobile", false, assert.fail);
    assert.equal(h.state().browserPreviewsBySession.chat.device, "mobile");
    h.dispose();
  },
);

await check(
  "closed browsers suppress both late screenshot results and screenshot errors",
  async () => {
    for (const failed of [false, true]) {
      const started = deferred(),
        result = deferred();
      const h = harness(async () => null);
      const attached = [],
        notices = [];
      const capture = h.capture(
        async () => {
          started.resolve();
          return result.promise;
        },
        attached,
        notices,
      );
      const taking = capture();
      await started.promise;
      const closing = h.bridge.close("chat", assert.fail);
      h.dispatch({
        type: "browser-session",
        sessionId: "chat",
        action: { type: "browser-close" },
      });
      const closed = h.state();
      await closing;
      if (failed) result.reject(new Error("late capture failure"));
      else result.resolve({ filename: "old.png" });
      await taking;
      assert.equal(h.state(), closed);
      assert.deepEqual(attached, []);
      assert.deepEqual(notices, []);
      h.dispose();
    }
  },
);

await check(
  "a current screenshot is displayed and attached to its owning chat",
  async () => {
    const h = harness();
    const attached = [],
      notices = [];
    const image = {
      path: "/tmp/fixture.png",
      filename: "fixture.png",
      width: 390,
      height: 844,
      createdAt: "2026-11-07T00:00:00Z",
    };
    await h.capture(async () => image, attached, notices)();
    assert.equal(
      h.state().browserPreviewsBySession.chat.captureStatus,
      "captured",
    );
    assert.equal(h.state().browserPreviewsBySession.chat.latestCapture, image);
    assert.deepEqual(attached, [image]);
    assert.deepEqual(notices, []);
    h.dispose();
  },
);

await check("a current screenshot error remains visible", async () => {
  const h = harness();
  const attached = [],
    notices = [];
  await h.capture(
    async () => {
      throw new Error("capture rejected");
    },
    attached,
    notices,
  )();
  assert.equal(h.state().browserPreviewsBySession.chat.captureStatus, "failed");
  assert.ok(
    h
      .state()
      .browserPreviewsBySession.chat.captureError.includes("capture rejected"),
  );
  assert.equal(notices.length, 1);
  assert.deepEqual(attached, []);
  h.dispose();
});

console.log(
  JSON.stringify(
    { ok: true, cases: cases.length, checks: cases, measurements },
    null,
    2,
  ),
);
