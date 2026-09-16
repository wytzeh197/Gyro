// Development-only interaction fixture. No native commands or model calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  type ChatSidePanelId,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const event = (
  id: string,
  kind: SessionEvent["kind"],
  message: string,
  payload = {},
): SessionEvent => ({
  id,
  kind,
  message,
  payload,
  sessionId: "canvas-fixture",
  turnId: "turn-1",
  createdAt: "2026-09-16T09:00:00Z",
});
const document = {
  id: "checklist",
  kind: "canvas",
  title: "Launch checklist",
  format: "text",
  content:
    "Before launch\n\nVerify installation on both Mac architectures.\nWalk through a complete chat-to-preview workflow.\nCheck release notes against the shipped build.\n\nAfter launch\n\nCollect feedback from the first five users.",
};
const initial = [
  event("user", "user-message", "Draft a launch checklist in Canvas."),
];

function Fixture() {
  const [events, setEvents] = useState(initial);
  const [panel, setPanel] = useState<ChatSidePanelId>();
  const [sent, setSent] = useState("");
  return (
    <div
      style={{
        height: "100vh",
        minWidth: 900,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <nav
        aria-label="Fixture controls"
        style={{ display: "flex", gap: 12, padding: 12 }}
      >
        <button
          onClick={() =>
            setEvents([
              ...initial,
              event(
                "answer",
                "assistant-message",
                "The checklist is ready in Canvas.",
                {
                  artifacts: [
                    document,
                    {
                      id: "options",
                      kind: "table",
                      title: "Rollout options",
                      columns: ["Approach", "Effort"],
                      rows: [
                        ["Small alpha", "Low"],
                        ["Public launch", "Higher"],
                      ],
                    },
                  ],
                },
              ),
            ])
          }
        >
          Create canvas
        </button>
        <button
          onClick={() =>
            setEvents((current) => [
              ...current,
              event("revision", "assistant-message", "Updated the checklist.", {
                artifacts: [
                  {
                    ...document,
                    content:
                      "Updated checklist\n\nVerify installation.\nRun the smoke checks.\nCollect feedback.",
                  },
                ],
              }),
            ])
          }
        >
          Model revision
        </button>
        <button onClick={() => setPanel("files")}>Show Files</button>
        <button onClick={() => setPanel("canvas")}>Show Canvas</button>
        <button
          onClick={() => {
            window.document.documentElement.dataset.theme =
              window.document.documentElement.dataset.theme === "light"
                ? "dark"
                : "light";
          }}
        >
          Toggle theme
        </button>
      </nav>
      <output aria-label="Sent canvas request">{sent}</output>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatSurface
          events={events}
          config={{
            commandProfiles: [],
            modelProviders: [],
            requireCommandApproval: true,
            requireFileEditApproval: true,
            telemetryEnabled: false,
          }}
          activeChatPanel={panel}
          companionTabs={["canvas", "files"]}
          companionWidth={620}
          onSelectChatPanel={setPanel}
          onOpenCompanionTab={setPanel}
          onCloseCompanionDock={() => setPanel(undefined)}
          onSend={setSent}
          shellReady
        />
      </div>
    </div>
  );
}
createRoot(window.document.getElementById("root")!).render(<Fixture />);
