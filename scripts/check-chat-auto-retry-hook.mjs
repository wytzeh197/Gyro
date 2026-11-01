import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createChatAutoRetryController } from "../apps/desktop/src/chat-auto-retry.ts";

const source = readFileSync(
  new URL("../apps/desktop/src/use-chat-auto-retry.ts", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "retry.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const hook = tree.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "useChatAutoRetry",
);
assert.ok(hook);
const js = ts.transpileModule(
  hook.getText(tree).replace(/^export\s+/, "") + "\nuseChatAutoRetry;",
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;

function mount() {
  let now = 0,
    slot = 0,
    dirty = false,
    nextTimer = 0,
    current,
    result;
  const slots = [],
    effects = [],
    timers = new Map(),
    calls = [];
  const same = (a, b) =>
    a &&
    b &&
    a.length === b.length &&
    a.every((value, index) => Object.is(value, b[index]));
  const useChatAutoRetry = vm.runInNewContext(js, {
    createChatAutoRetryController,
    Date: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    useRef: (initial) => {
      const id = slot++;
      return (slots[id] ??= { current: initial });
    },
    useState: (initial) => {
      const id = slot++;
      slots[id] ??= { value: initial };
      return [
        slots[id].value,
        (update) => {
          const value =
            typeof update === "function" ? update(slots[id].value) : update;
          if (!Object.is(value, slots[id].value)) {
            slots[id].value = value;
            dirty = true;
          }
        },
      ];
    },
    useCallback: (callback, deps) => {
      const id = slot++;
      if (!same(slots[id]?.deps, deps)) slots[id] = { value: callback, deps };
      return slots[id].value;
    },
    useEffect: (callback, deps) => {
      const id = slot++;
      if (!same(slots[id]?.deps, deps)) {
        effects.push(() => {
          slots[id]?.cleanup?.();
          slots[id] = { deps, cleanup: callback() };
        });
      }
    },
  });
  const render = (options = current) => {
    current = options;
    for (let passes = 0; passes < 20; passes++) {
      dirty = false;
      slot = 0;
      result = useChatAutoRetry(current);
      effects.splice(0).forEach((effect) => effect());
      if (!dirty) return result;
    }
    throw Error("Retry hook entered a render loop");
  };
  const options = (eventsBySessionId, blocked = new Set()) => ({
    enabled: true,
    eventsBySessionId,
    sendingSessionIds: [...blocked],
    queueVersion: null,
    pauseVersion: 0,
    blockedSessionIds: () => blocked,
    onRetry: (event) => calls.push(event.id),
  });
  return {
    render,
    options,
    calls,
    timerCount: () => timers.size,
    result: () => result,
    advance: (ms) => {
      const until = now + ms;
      for (let ticks = 0; ticks < 1000; ticks++) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) {
          now = until;
          return;
        }
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        if (dirty) render();
      }
      throw Error("Retry hook entered a timer loop");
    },
    unmount: () => slots.forEach((entry) => entry?.cleanup?.()),
  };
}

const user = {
  id: "user",
  sessionId: "chat",
  turnId: "turn",
  kind: "user-message",
  message: "Polish this UI",
  createdAt: "2026-10-12T08:00:00Z",
  payload: {},
};
const failure = {
  ...user,
  id: "failure",
  kind: "system-event",
  message: "Model is temporarily busy.",
  payload: {
    kind: "provider-status",
    status: "failed",
    recoveryKind: "model-capacity",
  },
};
const ready = { chat: [user] },
  failed = { chat: [user, failure] };

const active = mount();
active.render(active.options(ready));
active.render(active.options(failed));
assert.equal(active.result().pending.failure.retryAt, 30_000);
active.advance(29_999);
assert.deepEqual(active.calls, []);
active.advance(1);
assert.deepEqual(active.calls, ["failure"]);
assert.equal(active.timerCount(), 0);
active.advance(60_000);
assert.deepEqual(
  active.calls,
  ["failure"],
  "one automatic send despite unchanged failure",
);

for (const action of ["cancel", "cancelSession", "unmount"]) {
  const instance = mount();
  instance.render(instance.options(ready));
  instance.render(instance.options(failed));
  instance.advance(12_000);
  if (action === "unmount") instance.unmount();
  else {
    instance.result()[action](action === "cancel" ? "failure" : "chat");
    instance.render();
  }
  instance.advance(30_000);
  assert.deepEqual(
    instance.calls,
    [],
    `${action} clears the real scheduled send`,
  );
  assert.equal(instance.timerCount(), 0);
}

const busy = mount();
busy.render(busy.options(ready));
busy.render(busy.options(failed, new Set(["chat"])));
busy.advance(35_000);
assert.deepEqual(
  busy.calls,
  [],
  "original sender still running cannot cause a duplicate send",
);
busy.render(busy.options(failed));
busy.advance(1_000);
assert.deepEqual(busy.calls, ["failure"]);

const history = mount();
history.render(history.options(failed));
history.advance(60_000);
assert.deepEqual(
  history.calls,
  [],
  "mounting an old failure cannot send anything",
);
// Execute the production send's plan selection with another chat focused.
const appSource = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const appTree = ts.createSourceFile(
  "App.tsx",
  appSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let planDeclaration;
function findPlan(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(appTree) === "turnPlan"
  )
    planDeclaration = node;
  ts.forEachChild(node, findPlan);
}
findPlan(appTree);
assert.ok(planDeclaration);
const planJs = ts.transpileModule(
  `const ${planDeclaration.getText(appTree)}; turnPlan;`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const focusedPlan = {
  title: "Other chat",
  items: [{ id: "other", text: "Do another task", status: "todo" }],
};
const choosePlan = (overrideContext) =>
  JSON.parse(
    JSON.stringify(
      vm.runInNewContext(planJs, {
        overrideContext,
        activeSessionPlan: focusedPlan,
      }),
    ),
  );
assert.deepEqual(
  choosePlan({ plan: undefined }),
  { title: "Plan", items: [] },
  "a background retry without a plan cannot borrow the focused chat's plan",
);
const originalPlan = { title: "Original", items: [] };
assert.deepEqual(choosePlan({ plan: originalPlan }), originalPlan);
assert.deepEqual(
  choosePlan(undefined),
  focusedPlan,
  "an ordinary focused send retains its plan",
);
const sendSource = appSource.slice(
  appSource.indexOf("const sendDraft = useCallback("),
);
assert.ok(
  sendSource.indexOf("chatAutoRetry.cancelSession(requestedSessionId)") <
    sendSource.indexOf("await settlePendingMedia"),
  "submitting a new message cancels recovery before pending media can delay it",
);
console.log(
  "Chat auto-retry hook: actual 30s dispatch, one send, cancellation, unmount cleanup, busy-session guard and historical mount pass.",
);
