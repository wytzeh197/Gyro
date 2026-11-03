// Development-only fixture. This module is never imported by app startup.
import React, { useState } from "react";
import {
  AppChrome,
  SettingsSurface,
  createInitialWorkbenchState,
  type SettingsSectionId,
  type GyroConfig,
  type WorkbenchPreferences,
} from "@gyro-dev/ui";
import { createRoot } from "react-dom/client";
import type { BillingSnapshot } from "../../../packages/ui/src/billing-settings";
import "@gyro-dev/ui/styles.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.density = "comfortable";
const object = "00000000-0000-4000-8000-000000000010",
  revision = "00000000-0000-4000-8000-000000000011";
const status =
  params.get("state") === "offline"
    ? "offline"
    : params.get("state") === "exhausted"
      ? "exhausted"
      : "active";
const premium = params.get("plan") === "premium";
const staging = params.get("environment") === "staging";
const snapshot: BillingSnapshot = {
  status,
  productionCloud: !staging,
  cloudV2: true,
  billingIdentity: "fixture-paid-period",
  staging,
  plan: params.get("plan") === "premium" ? "premium" : "plus",
  cloudCapabilities: {
    managedAi: {
      allowed:
        !staging &&
        !["exhausted", "paused", "offline"].includes(params.get("state") ?? ""),
      reason: staging
        ? "staging-ai-disabled"
        : params.get("state") === "exhausted"
          ? "exhausted"
          : params.get("state") === "paused"
            ? "service-paused"
            : "entitled",
    },
    selectedSync: { allowed: true, reason: "entitled" },
    backup: { allowed: true, reason: "entitled" },
    sharing: { allowed: true, reason: "entitled" },
  },
  accountLabel: "Fixture account · no real account",
  fetchedAt: "2026-11-02T12:00:00Z",
  accessUntil: "2026-12-02T12:00:00Z",
  limits: {
    devices: premium ? 5 : 2,
    storageBytes: premium ? 20000000000 : 2000000000,
    historyDays: premium ? 90 : 30,
    activeLinks: premium ? 100 : 10,
    concurrentJobs: premium ? 2 : 1,
    uploadBytesPerMonth: premium ? 40000000000 : 4000000000,
    downloadBytesPerMonth: premium ? 400000000000 : 40000000000,
  },
  cloudUsage: {
    managedAi: {
      unit: "percent",
      used: status === "exhausted" ? 100 : 12,
      held: 0,
      remaining: status === "exhausted" ? 0 : 88,
      resetAt: "2026-12-02T12:00:00Z",
    },
    storage: {
      usedBytes: 24000000,
      reservedBytes: 0,
      limitBytes: premium ? 20000000000 : 2000000000,
    },
  },
};
let deviceRevoked = false,
  linkRevoked = false;
const actions = {
  manage: () => {},
  refresh: () => {},
  cloud: {
    preferences: () => ({
      theme: "light",
      density: "comfortable",
      interfaceSize: "default",
      motionSpeed: "default",
    }),
    applySettings: () => {},
    continueChat: async () => true,
    request: async (r: Record<string, unknown>) => {
      if (
        (r.command as { operation?: string } | undefined)?.operation ===
        "last-payment"
      ) {
        const visa = params.get("card") === "visa";
        return {
          card: {
            brand: visa ? "visa" : "mastercard",
            last4: visa ? "4242" : "4444",
          },
        };
      }
      if (r.operation === "save-read-only-archive")
        return {
          content: r.content,
          notice: "Synthetic archive restored locally for this fixture.",
        };
      if (r.operation === "local-chats")
        return {
          items: [{ localId: object, title: "API error investigation" }],
        };
      if (r.operation === "preview-chat")
        return {
          ticket: object,
          kind: "chat",
          content: {
            title: "API error investigation",
            messages: [
              {
                role: "user",
                text: "The API returns 500 when the request body is empty.",
                createdAt: "2026-11-02T12:00:00Z",
              },
              {
                role: "assistant",
                text: "Check the missing-body validation and add a regression case.",
                createdAt: "2026-11-02T12:01:00Z",
              },
            ],
          },
        };
      if (r.operation === "preview-settings")
        return {
          ticket: object,
          kind: "settings",
          content: {
            theme: "light",
            density: "comfortable",
            interfaceSize: "default",
            motionSpeed: "default",
          },
        };
      if (r.operation === "project-memory-id") return { projectId: object };
      const c = (r.command ?? {}) as Record<string, unknown>;
      if (c.operation === "revoke-device") {
        deviceRevoked = true;
        return { revoked: true };
      }
      if (c.operation === "revoke-share") {
        linkRevoked = true;
        return { revoked: true };
      }
      if (c.operation === "list-shares")
        return {
          items: [
            {
              shareId: object,
              objectId: object,
              revisionId: revision,
              expiresAt: "2020-01-01T00:00:00Z",
              revokedAt: null,
              paused: false,
            },
            {
              shareId: revision,
              objectId: object,
              revisionId: revision,
              expiresAt: "2099-01-01T00:00:00Z",
              revokedAt: null,
              paused: true,
            },
            {
              shareId: "00000000-0000-4000-8000-000000000012",
              objectId: object,
              revisionId: revision,
              expiresAt: "2099-01-01T00:00:00Z",
              revokedAt: linkRevoked ? "2026-11-02T12:01:00Z" : null,
              paused: false,
            },
          ],
        };
      if (c.operation === "list-memory-proposals")
        return {
          items: [
            {
              extractionId: revision,
              status: params.get("memory") ?? "proposal",
              expectedRevision: 1,
              sources: [
                {
                  objectId: object,
                  revisionId: revision,
                  sourceFormat: "gyro-portable-chat-v1",
                },
              ],
            },
          ],
        };
      if (c.operation === "memory-proposal")
        return {
          extractionId: revision,
          status: "proposal",
          expectedRevision: 1,
          content: "Validate empty API requests before calling the provider.",
          sources: [
            {
              objectId: object,
              revisionId: revision,
              sourceFormat: "gyro-portable-chat-v1",
              messageRange: {
                startMessage: 0,
                startOffset: 0,
                endMessage: 1,
                endOffset: 0,
              },
            },
          ],
        };

      if (c.operation === "read-object")
        return {
          bytesBase64: btoa(
            JSON.stringify({
              format: "gyro-portable-chat-v1",
              title: "API error investigation",
              messages: [
                {
                  role: "user",
                  text: "The API returns 500 when the request body is empty.",
                  createdAt: "2026-11-02T12:00:00Z",
                },
                {
                  role: "assistant",
                  text: "Check the missing-body validation and add a regression case.",
                  createdAt: "2026-11-02T12:01:00Z",
                },
              ],
            }),
          ),
        };
      if (c.operation === "list-objects")
        return {
          items: [
            {
              objectId: object,
              headRevisionId: revision,
              kind: "chat",
              updatedAt: "2026-11-02T12:00:00Z",
              pinned: true,
            },
          ],
        };
      if (c.operation === "get-memory")
        return {
          revision: 1,
          content: "Validate empty API requests before calling the provider.",
          sources: [],
          sourceObjectIds: [],
          automaticEnabled: false,
        };
      if (c.operation === "devices")
        return {
          items: [
            {
              id: object,
              label: "This Mac",
              revokedAt: deviceRevoked ? "2026-11-02T12:00:00Z" : null,
            },
          ],
        };
      if (c.operation === "submit-job")
        return {
          id: object,
          status: "queued",
          kind: "suggestion",
          evidenceStatus: "not-observed",
        };
      if (c.operation === "job")
        return {
          id: object,
          status: "succeeded",
          result: {
            summary: "Validate the empty request body.",
            items: [
              { text: "Return a clear 400 before invoking the provider." },
            ],
          },
        };
      return { items: [], queued: false };
    },
  },
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
    params.get("section") === "billing" ? "billing" : "cloud",
  );
  const [preferences, setPreferences] = useState<WorkbenchPreferences>(() => ({
    ...createInitialWorkbenchState().preferences,
    settingsSections: {
      "cloud/gyro-account": false,
      "cloud/cloud-managed-usage": false,
      ...(params.get("open") ? { [`cloud/${params.get("open")}`]: true } : {}),
    },
  }));
  return (
    <AppChrome
      sessions={[]}
      commandProfiles={[]}
      savedProjects={[]}
      activeDestination="settings"
      activeWorkspaceLayout="thread"
      activeSettingsSection={section}
      workspacePath="/fixture/Gyro"
      onSettingsSectionChange={setSection}
      onOpenSettingsSection={setSection}
      onSelectSession={() => {}}
      onSelectWorkspaceLayout={() => {}}
      onSelectDestination={() => {}}
      onOpenToolPanel={() => {}}
      onOpenSettings={() => setSection("cloud")}
      onOpenCommandPalette={() => {}}
      onCreateSession={() => {}}
      onCreateCliSession={() => {}}
      onSelectSessions={() => {}}
      onOpenWorkspace={() => {}}
      onSettingsBack={() => {}}
      settingsBackLabel="fixture"
    >
      <SettingsSurface
        config={config}
        themeMode={params.get("theme") === "dark" ? "dark" : "light"}
        onThemeChange={() => {}}
        preferences={preferences}
        onSettingsPreferencesChange={(patch) =>
          setPreferences((current) => ({ ...current, ...patch }))
        }
        billingSnapshot={snapshot}
        billingActions={actions}
        activeSection={section}
        onSectionChange={setSection}
      />
    </AppChrome>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
