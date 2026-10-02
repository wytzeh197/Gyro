// Development-only visual fixture. No native commands or model calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatFileActionsContext,
  ChatSurface,
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
];
function Fixture() {
  const [action, setAction] = useState("");
  return (
    <ChatFileActionsContext.Provider
      value={{
        preview: async (path) => (path.endsWith(".mov") ? clip : screenshot),
        open: (path) => setAction(`Revealed ${path}`),
      }}
    >
      <output
        aria-live="polite"
        style={{ position: "fixed", bottom: 0, left: 0, zIndex: 10001 }}
      >
        {action}
      </output>
      <ChatSurface
        events={events}
        config={{
          commandProfiles: [],
          modelProviders: [],
          requireCommandApproval: true,
          requireFileEditApproval: true,
          telemetryEnabled: false,
        }}
        shellReady
        onSend={() => {}}
        onBrowserNavigate={(url) => setAction(`Opened ${url}`)}
      />
    </ChatFileActionsContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
