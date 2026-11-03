import assert from "node:assert/strict";
import {
  parseSettingsTransfer,
  exportSettingsTransfer,
} from "../packages/ui/src/settings-transfer.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";
import { newChatDefaultSelection } from "../apps/desktop/src/new-chat-defaults.ts";
import {
  completedCheckReminder,
  createCheckReminderTracker,
} from "../apps/desktop/src/check-reminder.ts";
import { readBillingSnapshot } from "../apps/desktop/src/billing-client.ts";

const initial = createInitialWorkbenchState();
assert.equal(initial.preferences.desktopNotifications.showNames, true);
assert.equal(initial.preferences.checkReminders, false);
assert.equal(initial.preferences.defaultChatProviderId, undefined);
assert.deepEqual(initial.preferences.settingsSections, {});
const portable = exportSettingsTransfer({
  ...initial.preferences,
  settingsSections: { "general/app-behavior": false },
  defaultChatProviderId: "openai",
  defaultChatEffort: "high",
  workspacePath: "/private/example",
  token: "secret",
});
for (const secret of [
  "settingsSections",
  "defaultChatProviderId",
  "defaultChatEffort",
  "workspacePath",
  "token",
])
  assert.ok(!portable.includes(secret));
const imported = parseSettingsTransfer(portable);
assert.deepEqual(
  imported.desktopNotifications,
  initial.preferences.desktopNotifications,
);
for (const bad of [
  "{",
  JSON.stringify({
    format: "gyro-settings",
    version: 2,
    settings: { theme: "dark" },
  }),
  JSON.stringify({
    format: "gyro-settings",
    version: 1,
    settings: { theme: "dark", providerConfiguration: {} },
  }),
  JSON.stringify({
    format: "gyro-settings",
    version: 1,
    settings: { theme: "dark", checkReminders: "yes" },
  }),
  JSON.stringify({
    format: "gyro-settings",
    version: 1,
    settings: { workspaceKeybindings: { constructor: null } },
  }),
])
  assert.throws(() => parseSettingsTransfer(bad));
const changed = workbenchReducer(initial, {
  type: "import-portable-settings",
  settings: parseSettingsTransfer(
    JSON.stringify({
      format: "gyro-settings",
      version: 1,
      settings: {
        theme: "dark",
        checkReminders: true,
        desktopNotifications: {
          enabled: true,
          approvals: true,
          finished: true,
          failed: true,
          showNames: false,
        },
      },
    }),
  ),
});
assert.equal(changed.preferences.theme, "dark");
assert.equal(changed.preferences.desktopNotifications.showNames, false);
assert.deepEqual(changed.providerStatuses, initial.providerStatuses);
assert.equal(initial.preferences.theme, "system", "import returns a new state");
const modeChanged = workbenchReducer(initial, {
  type: "set-default-workspace-mode",
  mode: "worktree",
});
assert.equal(
  modeChanged.workspaceMode,
  initial.workspaceMode,
  "new-chat defaults do not change active work",
);
for (const page of [
  "general",
  "import-projects",
  "editor-workspace",
  "tools-contributions",
  "usage-limits",
  "billing",
  "cloud",
])
  assert.equal(
    createInitialWorkbenchState({
      preferences: { ...initial.preferences, lastSettingsSection: page },
    }).preferences.lastSettingsSection,
    page,
  );
const restored = createInitialWorkbenchState({
  preferences: {
    ...initial.preferences,
    settingsSections: {
      "general/app-behavior": false,
      "bad key": true,
      "general/notifications": "yes",
    },
    defaultChatProviderId: { bad: true },
    defaultChatEffort: "bogus",
  },
});
assert.deepEqual(restored.preferences.settingsSections, {
  "general/app-behavior": false,
});
assert.equal(restored.preferences.defaultChatProviderId, undefined);
assert.equal(restored.preferences.defaultChatEffort, undefined);

const config = {
  selectedProviderId: "openai",
  modelProviders: [
    {
      id: "openai",
      displayName: "OpenAI",
      enabled: true,
      authStatus: "connected",
      selectedModelId: "test",
      defaultModelId: "test",
      models: [
        {
          id: "test",
          displayName: "Test",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
        },
      ],
    },
  ],
};
assert.equal(
  newChatDefaultSelection(config, initial.preferences),
  undefined,
  "last-used keeps existing selection behavior",
);
const prefs = {
  ...initial.preferences,
  defaultChatProviderId: "openai",
  defaultChatEffort: "high",
};
const draft = newChatDefaultSelection(config, prefs);
assert.equal(draft.reasoningEffort, "high");
prefs.defaultChatEffort = "ultra";
assert.equal(
  newChatDefaultSelection(config, prefs).reasoningEffort,
  "low",
  "unsupported effort falls back to supported model default",
);
assert.equal(
  draft.reasoningEffort,
  "high",
  "existing snapshot is isolated from preference edits",
);
assert.equal(
  newChatDefaultSelection(config, {
    ...prefs,
    defaultChatProviderId: "custom:missing",
  }).modelId,
  "",
  "missing fixed provider stays invalid",
);

const at = (n) => new Date(n).toISOString();
const event = (payload, extra = {}) => ({
  id: "event",
  sessionId: "s",
  turnId: "t",
  kind: "system-event",
  message: "",
  createdAt: at(1),
  payload,
  ...extra,
});
const edit = event({
  kind: "provider-activity",
  activityKind: "file",
  status: "done",
  path: "src/app.ts",
});
const done = event({
  kind: "provider-status",
  status: "done",
  completedAt: at(300),
});
assert.deepEqual(
  completedCheckReminder("s", [edit, done], 200),
  { sessionId: "s", turnId: "t" },
  "completion time survives status updates in place",
);
for (const status of ["failed", "cancelled", "stopped"])
  assert.equal(
    completedCheckReminder(
      "s",
      [edit, event({ ...done.payload, status })],
      200,
    ),
    undefined,
  );
assert.equal(
  completedCheckReminder(
    "s",
    [
      event({}, { kind: "assistant-message", message: "I edited the files" }),
      done,
    ],
    200,
  ),
  undefined,
);
assert.equal(
  completedCheckReminder("s", [{ ...edit, turnId: "old" }, done], 200),
  undefined,
);
const tracker = createCheckReminderTracker();
assert.deepEqual(
  tracker.observe(true, [], { s: [edit, done] }, 400),
  [],
  "history reload does not trigger reminders",
);
tracker.observe(true, ["s"], { s: [] }, 200);
assert.equal(tracker.observe(true, [], { s: [edit, done] }, 350).length, 1);
assert.deepEqual(
  tracker.observe(true, [], { s: [edit, done] }, 400),
  [],
  "completed turn is deduplicated",
);
const disabled = createCheckReminderTracker();
assert.deepEqual(disabled.observe(false, ["s"], { s: [edit, done] }, 200), []);
assert.deepEqual(disabled.observe(true, [], { s: [edit, done] }, 400), []);

const wallet = {
  periodId: "test",
  grantedMicros: 50000,
  spentMicros: 10000,
  reservedMicros: 5000,
  availableMicros: 35000,
};
const mock =
  (sub, wallets = [wallet], mode = "mock") =>
  async (url) =>
    new Response(
      JSON.stringify(
        url.endsWith("/account")
          ? { accountId: "synthetic", mode, subscription: sub }
          : { mode, currency: "USD", wallets },
      ),
      { status: 200 },
    );
const sub = {
  plan: "lite",
  valid_until: "2099-01-01T00:00:00Z",
  source: "test",
};
assert.equal(
  (await readBillingSnapshot("", "fake", mock(sub))).status,
  "active",
);
assert.equal(
  (await readBillingSnapshot("", "fake", mock(null))).status,
  "no-subscription",
);
assert.equal(
  (
    await readBillingSnapshot(
      "",
      "fake",
      mock({ ...sub, valid_until: "2000-01-01T00:00:00Z" }),
    )
  ).status,
  "expired",
);
assert.equal(
  (
    await readBillingSnapshot(
      "",
      "fake",
      mock(sub, [{ ...wallet, availableMicros: 0 }]),
    )
  ).status,
  "exhausted",
);
assert.equal(
  (
    await readBillingSnapshot(
      "",
      "fake",
      mock(sub, [{ ...wallet, availableMicros: 1234 }]),
    )
  ).usage[0].availableMicros,
  1234,
  "balance is exactly server reported",
);
await assert.rejects(() =>
  readBillingSnapshot("", "fake", mock(sub, undefined, "live")),
);
await assert.rejects(() =>
  readBillingSnapshot(
    "",
    "fake",
    mock(sub, [{ ...wallet, reservedMicros: -1 }]),
  ),
);
await assert.rejects(() =>
  readBillingSnapshot("", "fake", async () => {
    throw Error("offline");
  }),
);
console.log(
  "Settings upgrade: transfer validation, legacy defaults, draft isolation, reminder lifecycle and billing contract checks passed.",
);
