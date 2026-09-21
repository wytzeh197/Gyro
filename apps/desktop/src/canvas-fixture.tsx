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
const uiPiece = {
  id: "project-card",
  kind: "canvas",
  title: "Project card",
  format: "html",
  content: `<style>body{padding:28px;background:#f5f6f8;color:#20242a}main{max-width:520px;margin:auto}header{display:flex;align-items:center;justify-content:space-between}small{color:#596579}h1{font-size:27px;letter-spacing:-.7px;margin:18px 0 8px}p{color:#596579;line-height:1.6}article{background:white;padding:20px;border:1px solid #dce0e7;border-radius:14px;margin:22px 0}label{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid #edf0f4}label:last-child{border:0}input{accent-color:#0874df}button{border:0;border-radius:8px;background:#0874df;color:white;padding:11px 16px;font:inherit;cursor:pointer}progress{accent-color:#0874df;width:100%;height:8px}footer{display:flex;justify-content:space-between;align-items:center}</style><main><header><small>Gyro / Workspace</small><small>Alpha 49</small></header><h1>Ready for the next step.</h1><p>A small launch checklist you can actually use.</p><article><strong id="count">0 of 3 complete</strong><progress value="0" max="3"></progress><label><input type="checkbox">Review the interface</label><label><input type="checkbox">Try the interactions</label><label><input type="checkbox">Share your feedback</label></article><footer><small id="status">Your draft, in progress.</small><button id="finish">Mark all complete</button></footer></main><script>const boxes=[...document.querySelectorAll('input')];function update(){const n=boxes.filter(x=>x.checked).length;document.getElementById('count').textContent=n+' of 3 complete';document.querySelector('progress').value=n;document.getElementById('status').textContent=n===3?'Ready to go.':'Your draft, in progress.'}boxes.forEach(x=>x.addEventListener('change',update));document.getElementById('finish').onclick=()=>{boxes.forEach(x=>x.checked=true);update()};</script>`,
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
        <button
          onClick={() =>
            setEvents((current) => [
              ...current,
              event(
                "ui-" + current.length,
                "assistant-message",
                "Try the project card in Canvas.",
                { artifacts: [uiPiece] },
              ),
            ])
          }
        >
          Build UI piece
        </button>
        <button
          onClick={() =>
            setEvents((current) => [
              ...current,
              event(
                "ui-revision-" + current.length,
                "assistant-message",
                "Updated the same Canvas item.",
                {
                  artifacts: [
                    {
                      ...uiPiece,
                      content: uiPiece.content.replace(
                        "Ready for the next step.",
                        "Make it yours.",
                      ),
                    },
                  ],
                },
              ),
            ])
          }
        >
          Revise UI piece
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
