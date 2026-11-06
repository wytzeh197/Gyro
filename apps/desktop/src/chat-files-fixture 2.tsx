// Development-only visual fixture. No native commands or model calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatFileActionsContext,
  ChatSurface,
  providersForConfig,
  type GyroConfig,
  type SessionEvent,
} from "@gyro-dev/ui";
import screenshot from "../../../site/assets/screenshots/current-chat-dark.webp";
import clip from "../../../site/assets/motion/workflow-dark.mp4";
import "@gyro-dev/ui/styles.css";
const theme =
  new URLSearchParams(location.search).get("theme") === "light"
    ? "light"
    : "dark";
document.documentElement.dataset.theme = theme;
const composerFixture = new URLSearchParams(location.search).has("composer");
const mentionsFixture = new URLSearchParams(location.search).has("mentions");
const baseConfig: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: true,
  requireFileEditApproval: true,
  telemetryEnabled: false,
};
const config: GyroConfig = composerFixture ? {
  ...baseConfig,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(baseConfig).map((provider) =>
    provider.id === "openai"
      ? { ...provider, enabled: true, authStatus: "connected" }
      : provider,
  ),
} : baseConfig;
const events: SessionEvent[] = [
  {
    id: "user-files",
    sessionId: "files",
    turnId: "turn-files",
    kind: "user-message",
    createdAt: new Date().toISOString(),
    message: "Check these files and the recording.",
    payload: {
      attachments: [
        {
          id: "image",
          kind: "image",
          name: "Screenshot 2026-10-02 at 16.27.31.png",
          path: "/tmp/screenshot.png",
          size: 243_000,
          previewUrl: screenshot,
        },
        {
          id: "video",
          kind: "video",
          name: "Screen Recording 2026-10-02 at 16.27.05.mov",
          path: "/tmp/recording.mov",
          size: 1_700_000,
          previewUrl: clip,
        },
        {
          id: "pdf",
          kind: "workspace-file",
          name: "Gyro product plan.pdf",
          path: "/tmp/plan.pdf",
          mimeType: "application/pdf",
          size: 840_000,
        },
        {
          id: "sheet",
          kind: "workspace-file",
          name: "Q4 budget.xlsx",
          path: "/tmp/budget.xlsx",
          size: 24_000,
        },
      ],
    },
  },
  {
    id: "assistant-files",
    sessionId: "files",
    turnId: "turn-files",
    kind: "assistant-message",
    createdAt: new Date().toISOString(),
    message:
      "Here are the linked files:\n\n![Workspace preview](/tmp/screenshot.png)\n\n[Screen Recording 2026-10-02 at 16.27.05.mov](/tmp/recording.mov)\n\n[Product plan.pdf](/tmp/plan.pdf) [Q4 budget.xlsx](/tmp/budget.xlsx)\n\nOrdinary [documentation](https://example.com/docs) stays inline.",
    payload: {},
  },
  {
    id: "user-short",
    sessionId: "files",
    turnId: "turn-short",
    kind: "user-message",
    createdAt: new Date().toISOString(),
    message: "Make this smaller.",
    payload: {},
  },
  {
    id: "user-long",
    sessionId: "files",
    turnId: "turn-long",
    kind: "user-message",
    createdAt: new Date().toISOString(),
    message: "Please keep longer messages readable while making the user bubble narrower than the assistant response. Short messages should fit their text, and attached screenshots should stay small until I click to open the full image.",
    payload: {},
  },
];
function Fixture() {
  const [action, setAction] = useState("");
  const [draft, setDraft] = useState("");
  return (
    <ChatFileActionsContext.Provider
      value={{
        preview: async (path) => (path.endsWith(".mov") ? clip : screenshot),
        open: (path) => setAction(`Revealed ${path}`),
      }}
    >
      <output
        aria-live="polite"
        style={{ position: "fixed", top: 14, right: 48, zIndex: 10001, fontSize: 11, color: "var(--gyro-muted)", background: "var(--gyro-app)", padding: "4px 8px", borderRadius: 6 }}
      >
        Fixture · {mentionsFixture ? "Inline file mentions" : composerFixture ? "Compact composer" : "Compact user messages"} {action ? `· ${action}` : ""}
      </output>
      <ChatSurface
        events={mentionsFixture ? events.slice(0, 2).map((event) => ({ ...event, payload: {}, message: event.kind === "user-message" ? "Show file mentions as normal text links." : "Start with [theme foundations](/workspace/packages/ui/src/styles-foundation.css), [chat styling](/workspace/packages/ui/src/chat.css), and [existing corner treatment](/workspace/docs/corner-treatment.md).\n\nOpen the [product plan](/tmp/plan.pdf) or the [budget spreadsheet](/tmp/budget.xlsx) to review them. These filenames should match the surrounding text size." })) : composerFixture ? events.slice(0, 2).map((event) => ({ ...event, payload: {}, message: event.kind === "user-message" ? "Make the composer 5% smaller." : "Use the composer below to check typing and controls." })) : new URLSearchParams(location.search).has("compact")
          ? events.map((event, index) => index === 0
            ? { ...event, message: "Is that the official place of the traffic light buttons?", payload: { attachments: [{ id: "image", kind: "image", name: "Screenshot.png", path: "/tmp/screenshot.png", size: 243_000, previewUrl: screenshot }] } }
            : index === 1
              ? { ...event, message: "Click the thumbnail to view the full screenshot." }
              : event)
          : events}
        config={config}
        draft={draft}
        onDraftChange={setDraft}
        sessionModel={composerFixture ? { providerId: "openai", modelId: "gpt-6.1-sol", modelLabel: "GPT-6.1 Sol" } : undefined}
        onComposerAction={(value) => setAction(value)}
        shellReady
        onSend={() => {}}
        onBrowserNavigate={(url) => setAction(`Opened ${url}`)}
      />
    </ChatFileActionsContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
