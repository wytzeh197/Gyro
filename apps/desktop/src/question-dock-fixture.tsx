// Development-only check page: the production chat surface with a pending
// question, so the card's geometry in the dock can be looked at without the
// desktop bridge or a provider call. The route owns the full viewport, so the
// browser pane size decides the chat width.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  providersForConfig,
  type GyroConfig,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const emptyConfig: GyroConfig = {
  telemetryEnabled: false,
  requireCommandApproval: false,
  requireFileEditApproval: false,
  modelProviders: [],
  commandProfiles: [],
};
const config: GyroConfig = {
  ...emptyConfig,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(emptyConfig).map((provider) =>
    provider.id === "openai"
      ? { ...provider, enabled: true, authStatus: "connected" }
      : provider,
  ),
};

const answer =
  "1. The counts are per tool call, so 429 is the ceiling this turn hit.\n\n" +
  "It's a big, risky refactor for a still-failing gate. The cleanest path is a " +
  "303-line exact-match change.\n\n" +
  "How do you want to close it?\n" +
  "- **A** — I extract the terminal-attachment domain into a focused module now " +
  "(removes ~355 lines), and separately extract/park the rest (likely moving " +
  "`LiveTerminalPaneBody` to clear all 429.\n" +
  "- **B** — Treat it as a dedicated pre-release extraction pass across " +
  "`App.tsx` **and** `lib.rs` (which is 254 over and mostly not this feature).\n" +
  "- **C** — Something else (e.g. you handle `App.tsx` holistically and I only " +
  "move my feature's module).";

const sessionId = "question-fixture";
const events: SessionEvent[] = [
  {
    id: "asked",
    sessionId,
    turnId: "turn-1",
    kind: "user-message",
    createdAt: "2026-09-22T12:00:00Z",
    message: "Make the line counts work regardless of model.",
    payload: {},
  },
  {
    id: "question",
    sessionId,
    turnId: "turn-1",
    kind: "assistant-message",
    createdAt: "2026-09-22T12:00:05Z",
    message: answer,
    payload: { kind: "provider-response", status: "done" },
  },
];

function Fixture() {
  const [draft, setDraft] = useState("");
  return (
    <div className="gyro-workspace-route is-thread">
      <section className="gyro-workspace-primary" aria-label="Question card">
        <ChatSurface
          config={config}
          events={events}
          sessionTitle="Line counts across models"
          paneKey="question-dock-fixture"
          workspacePath="/Users/dev/Gyro"
          branchName="main"
          sessionModel={{
            providerId: "openai",
            modelId: "gpt-6-astra",
            modelLabel: "GPT-6 Astra",
            reasoningEffort: "ultra",
          }}
          draft={draft}
          onDraftChange={setDraft}
          onComposerAction={() => {}}
          onSend={() => {}}
          onStopChat={() => {}}
        />
      </section>
    </div>
  );
}

if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
