// Explicit development entry only. No real accounts, files, payments or models.
import React, { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  AppChrome,
  SettingsSurface,
  createInitialWorkbenchState,
  type GyroConfig,
  type WorkbenchPreferences,
  type SettingsSectionId,
} from "@gyro-dev/ui";
import { CloudV3Settings, type V3Invoke } from "./cloud-v3-settings";
import { CloudV3Navigation } from "./cloud-v3-navigation";
import type { BillingSnapshot } from "../../../packages/ui/src/billing-settings";
import "@gyro-dev/ui/styles.css";
import cloudContract from "../../../docs/contracts/gyro-cloud-v3.json";
const fixturePlanId =
  new URLSearchParams(location.search).get("state") === "plus"
    ? "plus"
    : new URLSearchParams(location.search).get("state") === "max"
      ? "max"
      : "cloud";
const fixturePlan = cloudContract.plans[fixturePlanId];
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.density = "comfortable";
const currentDate = new Date();
const fixtureReset = new Date(currentDate);
fixtureReset.setMonth(fixtureReset.getMonth() + 1);
const fixtureExport = new Date(fixtureReset);
fixtureExport.setDate(fixtureExport.getDate() + 30);
const id = "00000000-0000-4000-8000-000000000010",
  rev = "00000000-0000-4000-8000-000000000011";
let connected = !["signed-out", "unconfigured"].includes(
    params.get("state") || "",
  ),
  saved = [
    "upload",
    "pending",
    "pending-error",
    "pending-multiple",
    "pending-completed",
    "pending-verifying",
    "pending-mixed",
    "pending-long",
  ].includes(params.get("state") || "");
let restarted = false;
let profile = {
  accountId: id,
  email: "alex@example.com",
  displayName: "Alex Morgan",
  deviceId: id,
};
let fixtureDevices = [
  {
    id,
    label: "MacBook Pro",
    lastSeenAt: currentDate.toISOString(),
    revokedAt: null as string | null,
  },
  {
    id: "00000000-0000-4000-8000-000000000020",
    label: "iPhone",
    lastSeenAt: new Date(currentDate.getTime() - 7200000).toISOString(),
    revokedAt: null as string | null,
  },
];
let fixtureVersions = [
  ...[0, 1, 2].map((n) => ({
    id: n === 0 ? rev : `00000000-0000-4000-8000-00000000001${n + 2}`,
    object_id: id,
    head_id: rev,
    label: "Gyro app",
    kind: "project",
    size_bytes: 548000000,
    sha256: "a".repeat(64),
    conflict: false,
    device_label: "MacBook Pro",
    created_at: new Date(
      currentDate.getTime() - (n * 86400000 + 3600000),
    ).toISOString(),
  })),
  ...[0, 1].map((n) => ({
    id: `00000000-0000-4000-8000-00000000003${n}`,
    object_id: "00000000-0000-4000-8000-000000000029",
    head_id: "00000000-0000-4000-8000-000000000030",
    label: "Website",
    kind: "project",
    size_bytes: 124000000,
    sha256: "b".repeat(64),
    conflict: false,
    device_label: "MacBook Pro",
    created_at: new Date(
      currentDate.getTime() - (n + 1) * 86400000,
    ).toISOString(),
  })),
];
let pendingReads = 0;
let cancelTransfer: ((value: any) => void) | null = null;
const call: V3Invoke = async (r) => {
  if (params.get("state") === "loading" && r.operation === "view")
    await new Promise((resolve) => setTimeout(resolve, 3000));
  if (r.operation === "view")
    return {
      contractVersion: "3.0.0",
      policyVersion: "2026-11-07-v2",
      configured: params.get("state") !== "unconfigured",
      connected,
      accountId: connected ? id : null,
      registered: params.get("state") !== "registration",
    };
  if (r.operation === "profile") return { ...profile };
  if (r.operation === "update-profile") {
    profile = { ...profile, displayName: String(r.displayName) };
    return { ...profile };
  }
  if (r.operation === "restore-project")
    return params.get("state") === "restore-cancel"
      ? { cancelled: true }
      : { restored: true };
  if (r.operation === "export-files")
    return { exported: fixtureVersions.length, cancelled: false };
  if (r.operation === "register-device") return { registered: true };
  if (r.operation === "begin") return { codeRequested: true };
  if (r.operation === "verify" || r.operation === "reconnect") {
    connected = true;
    return {};
  }
  if (r.operation === "sign-out") {
    connected = false;
    if (params.get("state") === "signout-error")
      throw new Error("Fixture remote revocation unavailable");
    return {};
  }
  if (r.operation === "pending") {
    pendingReads++;
    const item = {
      requestId: id,
      label:
        params.get("state") === "pending-long"
          ? "Selected project with a very long descriptive name and important implementation notes"
          : "Selected chat",
      kind: "chat",
      prepared: { size: 42000 },
      uploadId:
        params.get("state") === "pending-error" && !restarted ? rev : null,
      localRunning: false,
      cancelRequested: false,
      cloudStatus: params.get("state") === "pending-verifying" ? (pendingReads < 2 ? "verifying" : "committed") : ["pending-completed", "pending-mixed"].includes(params.get("state") || "") ? "committed" : null,
    };
    return saved
      ? ["pending-multiple", "pending-completed", "pending-mixed"].includes(params.get("state") || "")
        ? [
            item,
            {
              ...item,
              requestId: rev,
              cloudStatus: params.get("state") === "pending-completed" ? "committed" : null,
              label: "Gyro app",
              kind: "project",
              prepared: { size: 548000000 },
            },
          ]
        : [item]
      : [];
  }
  if (r.operation === "preview-project")
    return {
      ticket: id,
      files: [
        { path: "README.md", size: 1200 },
        { path: "src/main.ts", size: 3200 },
      ],
      excluded: [".git", "node_modules", ".env"],
      sensitiveFindings: [],
      payloadBytes: 5200,
    };
  if (r.operation === "prepare") {
    saved = true;
    return { requestId: id };
  }
  if (r.operation === "renew") {
    restarted = true;
    return {};
  }
  if (r.operation === "resume") {
    if (params.get("state") === "pending-error" && !restarted)
      throw new Error(
        "This upload could not continue. Your prepared copy is preserved.",
      );
    if (params.get("state") === "upload")
      return new Promise((resolve) => {
        cancelTransfer = resolve;
      });
    return { status: "verifying" };
  }
  if (r.operation === "cancel") {
    saved = false;
    cancelTransfer?.({ status: "cancelled" });
    cancelTransfer = null;
    return {};
  }
  if (r.operation === "local-chats")
    return { items: [{ id, title: "Fixture selected chat" }] };
  if (r.operation === "preview-chat")
    return {
      ticket: id,
      content: {
        archive: {
          messages: [
            { role: "user", text: "Fixture: investigate the selected error." },
            {
              role: "assistant",
              text: "Fixture assertion: a test was proposed, not run.",
            },
          ],
        },
        unsupported: [
          "Tool payloads, attachments and runtime authority excluded.",
        ],
      },
    };
  if (r.operation === "save-chat") {
    saved = true;
    return {};
  }
  if (r.operation === "service") {
    const c = r.command as any;
    if (c.operation === "capabilities")
      return {
        phone: params.get("state") === "phone",
        cloudPurchase: false,
        plusPurchase: false,
      };
    if (c.operation === "policy")
      return {
        policyVersion: cloudContract.policyVersion,
        plans: cloudContract.plans,
        proposed: true,
      };
    if (c.operation === "usage") {
      if (params.get("state") === "offline")
        throw new Error("Fixture: Cloud is offline.");
      return {
        active: true,
        policy: fixturePlan,
        operations: 1400,
        resetAt: fixtureReset.toISOString(),
        exportUntil: fixtureExport.toISOString(),
        storage: {
          used: params.get("state") === "capacity" ? 4.8e9 : 1.9e9,
          reserved: 0,
          warning: params.get("state") === "capacity" ? "95-percent" : null,
        },
        transfer: { uploaded: 16.4e9, reserved: 0, downloaded: 4.1e9 },
      };
    }
    if (c.operation === "phone-pair")
      return {
        pairId: id,
        secret: "fixture-not-a-real-secret",
        expiresAt: "2026-11-06T23:55:00Z",
        url: "https://companion.fixture.invalid/phone",
      };
    if (c.operation === "phone-devices") return [];
    if (c.operation === "wallet")
      return {
        currency: params.get("state") === "invalid-wallet" ? "EUR" : "USD",
        includedMicros: fixturePlan.aiMicros,
        qualified: true,
        resetAt: fixtureReset.toISOString(),
        topUpsAvailable: false,
        model: "gpt-6-luna",
        usable: fixturePlan.aiMicros > 0,
        checkAllowed: params.get("state") === "plus",
        availableMicros:
          fixturePlan.aiMicros > 0 ? fixturePlan.aiMicros - 1e6 : 0,
        spentMicros: fixturePlan.aiMicros > 0 ? 8e5 : 0,
        heldMicros: fixturePlan.aiMicros > 0 ? 2e5 : 0,
      };
    if (c.operation === "versions")
      return {
        items: params.get("state") === "empty" ? [] : fixtureVersions,
        nextCursor: null,
      };
    if (c.operation === "devices")
      return { items: fixtureDevices.map((d) => ({ ...d })) };
    if (c.operation === "revoke-device") {
      fixtureDevices = fixtureDevices.map((d) =>
        d.id === c.deviceId ? { ...d, revokedAt: new Date().toISOString() } : d,
      );
      return {};
    }
    if (c.operation === "delete-version") {
      fixtureVersions = fixtureVersions.filter((v) => v.id !== c.revisionId);
      return {};
    }
    if (c.operation === "submit") return { id, status: "queued" };
    if (c.operation === "job" || c.operation === "recover-last-job")
      return {
        id,
        status: "succeeded",
        model: "gpt-6-luna",
        result: {
          summary: "Fixture draft: preserve the selected goal and unknowns.",
          items: [{ text: "The proposed test has not been run." }],
          limitations: ["Fixture output only."],
        },
      };
    if (c.operation === "begin-export")
      return {
        id,
        expires_at: "2026-11-07T10:00:00Z",
        exportByteLimit: 2.2e9,
        exportServedBytes: 0,
        exportOperationLimit: 1000,
      };
  }
  return {};
};
const config: GyroConfig = {
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  modelProviders: [],
  commandProfiles: [],
};
function Preview() {
  const [section, setSection] = useState<SettingsSectionId>(
    params.get("page") === "account" ? "account" : "cloud",
  );
  const [accountConnected, setAccountConnected] = useState(connected);
  const previewCall = useCallback<V3Invoke>(async (request) => {
    const value = await call(request);
    if (request.operation === "view")
      setAccountConnected(Boolean(value.connected));
    if (request.operation === "update-profile")
      refreshProfile((value) => value + 1);
    return value;
  }, []);
  const [, refreshProfile] = useState(0);
  const account = {
    snapshot: {
      status: accountConnected ? "active" : "signed-out",
      accountLabel: accountConnected
        ? profile.displayName || profile.email
        : undefined,
    } as BillingSnapshot,
    actions: {},
  };
  const [preferences, setPreferences] = useState<WorkbenchPreferences>(
    createInitialWorkbenchState().preferences,
  );
  return (
    <AppChrome
      sessions={[]}
      commandProfiles={[]}
      savedProjects={[]}
      activeDestination="settings"
      activeWorkspaceLayout="thread"
      activeSettingsSection={section}
      onOpenSettingsSection={setSection}
      onSettingsSectionChange={setSection}
      settingsBackLabel="Sessions"
      accountNavigation={
        <CloudV3Navigation
          call={previewCall}
          selected={section}
          onSelect={setSection}
        />
      }
      onSelectSession={() => {}}
      onSelectWorkspaceLayout={() => {}}
      onSelectDestination={() => {}}
      onOpenToolPanel={() => {}}
      onOpenSettings={() => {}}
      onOpenCommandPalette={() => {}}
      onCreateSession={() => {}}
      onCreateCliSession={() => {}}
      onSelectSessions={() => {}}
      onOpenWorkspace={() => {}}
    >
      <SettingsSurface
        config={config}
        themeMode={params.get("theme") === "dark" ? "dark" : "light"}
        onThemeChange={() => {}}
        preferences={preferences}
        onSettingsPreferencesChange={(patch) =>
          setPreferences((p) => ({ ...p, ...patch }))
        }
        activeSection={section}
        onSectionChange={setSection}
        billingSettings={
          <CloudV3Settings
            page="billing"
            call={previewCall}
            previewLabel="Development preview · Sample data"
            openExternal={async () => {}}
          />
        }
        accountSettings={
          <CloudV3Settings
            page="account"
            call={previewCall}
            previewLabel="Development preview · Sample data"
            openExternal={async () => {}}
          />
        }
        cloudSettings={
          <>
            <CloudV3Settings
              call={previewCall}
              initialTab={
                params.get("tab") === "usage"
                  ? "usage"
                  : params.get("tab") === "chats"
                    ? "chats"
                    : "projects"
              }
              previewLabel="Development preview · Sample data"
              openExternal={async () => {}}
            />
          </>
        }
      />
    </AppChrome>
  );
}
const previewRoot = createRoot(document.getElementById("root")!);
import.meta.hot?.dispose(() => previewRoot.unmount());
previewRoot.render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
