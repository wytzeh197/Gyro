// Standalone production sidebar/grid fixture; no native IPC or providers.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppChrome, ChatGridSurface, ChatSurface, chatGridReducer,
  createChatProjectLayout, type ChatGridState, type Session, type GyroConfig } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const projectKey = "/fixture/Gyro";
const sessions: Session[] = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((title, i) => ({
  id: title.toLowerCase(), title: `Fixture chat ${title}`, workspacePath: projectKey,
  origin: "desktop", createdAt: "2026-10-10T10:00:00Z",
  updatedAt: "2026-10-10T10:00:00Z", eventsPath: `/fixture/${i}.jsonl`,
}));
const paneFor = (id: string) => ({ paneId: id, kind: "session" as const, sessionId: id, workspacePath: projectKey });
const initialState = (): ChatGridState => ({ activeProjectKey: projectKey,
  layouts: { [projectKey]: createChatProjectLayout(projectKey, paneFor("alpha")) } });
const config: GyroConfig = { telemetryEnabled: false, requireCommandApproval: false,
  requireFileEditApproval: false, modelProviders: [], commandProfiles: [] };

// Exercise production handlers without relying on native bridge mocks.
// Each release happens in the same task as dragstart, before React can paint.
function simulateDrop(sessionId: string, fraction: number, hidden = false, outside = false) {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".gyro-session-row"))
    .find(element => element.textContent?.includes(`Fixture chat ${sessionId[0]!.toUpperCase() + sessionId.slice(1)}`));
  const grid = document.querySelector<HTMLElement>(".gyro-chat-grid");
  if (!row || !grid) throw new Error("Fixture drag source or target missing");
  const startTransfer = new DataTransfer();
  row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: startTransfer }));
  const transfer = hidden ? new DataTransfer() : startTransfer;
  if (hidden) transfer.setData("text/uri-list", "https://fixture.invalid/image.png");
  const bounds = grid.getBoundingClientRect();
  (outside ? document.querySelector(".gyro-sidebar-thread-main")! : grid).dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: bounds.left + bounds.width * fraction, clientY: bounds.top + bounds.height / 2 }));
  row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: startTransfer }));
}

function Preview() {
  const [grid, setGrid] = useState(initialState);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [active, setActive] = useState("alpha");
  const [media, setMedia] = useState(0);
  const layout = grid.layouts[projectKey]!;
  const dispatch = (action: Parameters<typeof chatGridReducer>[1]) => setGrid(current => chatGridReducer(current, action));
  return <AppChrome activeDestination="workspace" activeSessionId={active}
    activeWorkspaceLayout="thread" commandProfiles={[]} savedProjects={[]}
    sessions={sessions} pinnedSessionIds={[]} workspacePath={projectKey}
    openChatSessionIds={layout.slots.flatMap(pane => pane?.kind === "session" ? [pane.sessionId] : [])}
    onCreateCliSession={() => undefined} onCreateSession={() => undefined}
    onOpenCommandPalette={() => undefined} onOpenSettings={() => undefined}
    onOpenToolPanel={() => undefined} onOpenWorkspace={() => undefined}
    onSelectDestination={() => undefined} onSelectSession={setActive}
    onSelectSessions={() => undefined} onSelectWorkspaceLayout={() => undefined}>
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
      <nav aria-label="Splitview drag fixture controls" style={{ padding: 10, display: "flex", flexWrap: "wrap", gap: 12, color: "var(--gyro-text)" }}>
        <strong>Splitview drag fixture</strong>
        <button onClick={() => { setGrid(initialState()); setDrafts({}); setMedia(0); }}>Reset fixture</button>
        <button onClick={() => simulateDrop("beta", 0.98)}>Quick drop Beta right</button>
        <button onClick={() => simulateDrop("gamma", 0.02, true)}>Hidden payload Gamma left</button>
        <button onClick={() => simulateDrop("alpha", 0.98, true)}>Move Alpha right</button>
        <button onClick={() => simulateDrop("beta", 0.98, true, true)}>Drop outside grid</button>
        <output aria-live="polite">Order: {layout.slots.flatMap(pane => pane?.kind === "session" ? [pane.sessionId] : []).join(", ")} · Media drops: {media}</output>
      </nav>
      <ChatGridSurface layout={layout} maximizedPaneId={grid.maximizedPaneId}
        onFocusPane={pane => dispatch({ type: "focus-pane", projectKey, paneId: pane.paneId })}
        onMovePane={(paneId, slotIndex) => dispatch({ type: "move-pane", projectKey, paneId, slotIndex })}
        onToggleMaximize={paneId => dispatch({ type: "toggle-maximize-pane", paneId })}
        onDropSession={(sessionId, _source, slotIndex, placement) => {
          dispatch({ type: "select-pane", projectKey, pane: paneFor(sessionId), mode: "drop", slotIndex, ...placement });
          setActive(sessionId);
        }}
        renderPane={(pane, options) => <ChatSurface config={config} events={[]}
          sessionTitle={sessions.find(session => session.id === (pane.kind === "session" ? pane.sessionId : ""))?.title}
          workspacePath={projectKey} paneKey={pane.paneId} isTiled={options.isTiled}
          draft={drafts[pane.paneId] ?? ""} onDraftChange={draft => setDrafts(current => ({ ...current, [pane.paneId]: draft }))}
          onAttachMediaFiles={() => setMedia(count => count + 1)}
          onCloseChat={() => dispatch({ type: "close-pane", projectKey, paneId: pane.paneId })}
          onComposerAction={() => undefined} onSend={() => undefined} />}
      />
    </div>
  </AppChrome>;
}
if (import.meta.env.DEV) {
  document.documentElement.dataset.theme = "light";
  createRoot(document.getElementById("root")!).render(<Preview />);
}
