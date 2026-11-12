// Development-only failure diagnostics fixture; all events are simulated.
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatRun, type SessionEvent } from "@gyro-dev/ui";
import { buildRunModel } from "../../../packages/ui/src/chat-run";
import "@gyro-dev/ui/styles.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("theme") === "light" ? "light" : "dark";
const event = (id: string, payload: Record<string, unknown>): SessionEvent => ({
  id, sessionId: "failure-fixture", turnId: "turn", kind: "system-event",
  createdAt: "2026-11-12T12:00:00Z", message: "",
  payload,
});
const events = [
  event("edit-failed", {
    kind: "capability-call", schema: "gyro.capability.v1",
    capabilityId: "workspace-edit", status: "failed",
    summary: "oldString was not found in src/app.ts; re-read the file and match it exactly.",
  }),
  event("command-failed", {
    kind: "provider-activity", activityKind: "command", status: "failed",
    label: "node scripts/check-theme.mjs",
    note: "Exit code: 1\nError: Chromium executable was not found.\n<test-output> is plain text.",
  }),
  event("command-passed", {
    kind: "provider-activity", activityKind: "command", status: "done",
    label: "node scripts/check-theme.mjs",
  }),
];
if (query.get("state") === "running") events.push(event("running", {
  kind: "provider-activity", activityKind: "command", status: "running",
  label: "node scripts/check-focus.mjs",
}));
const model = buildRunModel(query.get("state") === "empty" ? [] : events, {
  isRunning: query.get("state") === "running",
});
createRoot(document.getElementById("root")!).render(
  <main style={{ padding: "var(--gyro-space-panel)", color: "var(--gyro-text)", background: "var(--gyro-surface)", minHeight: "100vh" }}>
    <p>Failure diagnostics · simulated events</p>
    <section className="gyro-chat-surface is-thread" style={{ height: "auto", overflow: "visible" }}>
      <div className="gyro-chat-turn"><div className="gyro-chat-run">
        <ChatRun model={model} suppressThinkingIndicator />
      </div></div>
    </section>
  </main>,
);
