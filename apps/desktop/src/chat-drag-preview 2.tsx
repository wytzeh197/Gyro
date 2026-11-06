// Standalone production sidebar/grid fixture; no providers or saved user chats.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import {
  AppChrome,
  ChatGridSurface,
  ChatSurface,
  chatGridReducer,
  currentChatDrag,
  chatProjectKey,
  createChatProjectLayout,
  type ChatGridState,
  type Session,
  type GyroConfig,
} from "@gyro-dev/ui";

import "@gyro-dev/ui/styles.css";

const isNativeDragSmoke = import.meta.env.MODE === "native-chat-drag-smoke";
const nativeDragEvents: Array<Record<string, unknown>> = [];
let reportSequence = 0;
let reportScheduled = false;
function reportNativeDragState() {
  if (!isNativeDragSmoke || reportScheduled) return;
  reportScheduled = true;
  requestAnimationFrame(() => {
    reportScheduled = false;
    const state = window.__chatDragFixture?.getState();
    if (!state) return;
    const grid = document.querySelector(".gyro-chat-grid");
    void invoke("report_chat_drag_smoke", {
      report: {
        sequence: ++reportSequence,
        href: location.href,
        userAgent: navigator.userAgent,
        state,
        activeDrag: currentChatDrag(),
        events: nativeDragEvents,
        feedback: {
          dragging: grid?.classList.contains("is-dragging"),
          sourceRows: Array.from(
            document.querySelectorAll(".gyro-session-row.is-dragging"),
          ).map((row) => row.textContent),
          zones: Array.from(
            document.querySelectorAll<HTMLElement>(".gyro-chat-grid-drop-zone"),
          ).map((zone) => ({
            position: zone.dataset.position,
            highlighted: zone.classList.contains("is-drop-target"),
          })),
        },
      },
    }).catch((error) => console.error("Native drag report failed", error));
  });
}
if (isNativeDragSmoke) {
  for (const type of [
    "dragstart",
    "dragenter",
    "dragover",
    "dragleave",
    "drop",
    "dragend",
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "lostpointercapture",
    "blur",
    "keydown",
  ]) {
    window.addEventListener(
      type,
      (event) => {
        if (event instanceof KeyboardEvent && event.key !== "Escape") return;
        const transfer =
          event instanceof DragEvent ? event.dataTransfer : undefined;
        const entry: Record<string, unknown> = {
          type,
          trusted: event.isTrusted,
          phase: "window-capture",
          target:
            event.target instanceof Element ? event.target.className : "window",
          activeDragAtCapture: currentChatDrag(),
          beforeHandlers: { prevented: event.defaultPrevented },
        };
        if (event instanceof DragEvent) {
          entry.x = event.clientX;
          entry.y = event.clientY;
          try {
            entry.types = Array.from(transfer?.types ?? []);
          } catch {
            entry.types = "protected";
          }
          try {
            Object.assign(entry.beforeHandlers as Record<string, unknown>, {
              effectAllowed: transfer?.effectAllowed,
              dropEffect: transfer?.dropEffect,
            });
          } catch {}
        }
        if (event instanceof PointerEvent) {
          Object.assign(entry, {
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            isPrimary: event.isPrimary,
            buttons: event.buttons,
            button: event.button,
            x: event.clientX,
            y: event.clientY,
          });
        }
        nativeDragEvents.push(entry);
        if (nativeDragEvents.length > 240) nativeDragEvents.shift();
        // Capture payload types while the store is readable; record acceptance
        // after the production source and grid handlers have seen this event.
        queueMicrotask(() => {
          const afterHandlers: Record<string, unknown> = {
            prevented: event.defaultPrevented,
          };
          try {
            afterHandlers.effectAllowed = transfer?.effectAllowed;
            afterHandlers.dropEffect = transfer?.dropEffect;
          } catch {}
          entry.afterHandlers = afterHandlers;
          reportNativeDragState();
        });
        reportNativeDragState();
      },
      true,
    );
  }
  window.addEventListener("dragstart", (event) => {
    if (!(event instanceof DragEvent) || !currentChatDrag()) return;
    const entry: Record<string, unknown> = {
      type: "dragstart-written",
      trusted: event.isTrusted,
      phase: "after-source-handlers",
    };
    try {
      entry.types = Array.from(event.dataTransfer?.types ?? []);
    } catch (error) {
      entry.error = String(error);
    }
    nativeDragEvents.push(entry);
    reportNativeDragState();
  });
  window.addEventListener("error", (event) => {
    nativeDragEvents.push({ type: "error", message: event.message });
    reportNativeDragState();
  });
}

const projectKey = "/fixture/Gyro";
const otherProjectKey = "/fixture/Other";
const sessions: Session[] = [
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
].map((title, i) => ({
  id: title.toLowerCase(),
  title: `Fixture chat ${title}`,
  workspacePath: title === "Zeta" ? otherProjectKey : projectKey,
  origin: "desktop",
  createdAt: "2026-10-10T10:00:00Z",
  updatedAt: "2026-10-10T10:00:00Z",
  eventsPath: `/fixture/${i}.jsonl`,
}));
const paneFor = (id: string, workspacePath = projectKey) => ({
  paneId: id,
  kind: "session" as const,
  sessionId: id,
  workspacePath,
});
const initialState = (): ChatGridState => ({
  activeProjectKey: projectKey,
  layouts: {
    [projectKey]: createChatProjectLayout(projectKey, paneFor("alpha")),
  },
});
const config: GyroConfig = {
  telemetryEnabled: false,
  requireCommandApproval: false,
  requireFileEditApproval: false,
  modelProviders: [],
  commandProfiles: [],
};

// Each release happens in the same task as dragstart, before React can paint.
function simulateDrop(
  sessionId: string,
  fraction: number,
  hidden = false,
  outside = false,
) {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>(".gyro-session-row"),
  ).find((element) =>
    element.textContent?.includes(
      `Fixture chat ${sessionId[0]!.toUpperCase() + sessionId.slice(1)}`,
    ),
  );
  const grid = document.querySelector<HTMLElement>(".gyro-chat-grid");
  if (!row || !grid) throw new Error("Fixture drag source or target missing");
  const startTransfer = new DataTransfer();
  row.dispatchEvent(
    new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: startTransfer,
    }),
  );
  const transfer = hidden ? new DataTransfer() : startTransfer;
  const bounds = grid.getBoundingClientRect();
  (outside
    ? document.querySelector(".gyro-sidebar-thread-main")!
    : grid
  ).dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: bounds.left + bounds.width * fraction,
      clientY: bounds.top + bounds.height / 2,
    }),
  );
  row.dispatchEvent(
    new DragEvent("dragend", { bubbles: true, dataTransfer: startTransfer }),
  );
}

type FixtureApi = {
  getState: () => {
    grid: ChatGridState;
    drafts: Record<string, string>;
    active: string;
    media: number;
  };
  setGrid: (grid: ChatGridState) => void;
  reset: () => void;
};
declare global {
  interface Window {
    __chatDragFixture: FixtureApi;
  }
}

function Preview() {
  const [grid, setGrid] = useState(initialState);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [active, setActive] = useState("alpha");
  const [media, setMedia] = useState(0);
  const activeProjectKey = grid.activeProjectKey ?? projectKey;
  const layout =
    grid.layouts[activeProjectKey] ?? createChatProjectLayout(activeProjectKey);
  const dispatch = (action: Parameters<typeof chatGridReducer>[1]) => {
    const current = gridRef.current;
    const next = chatGridReducer(current, action);
    gridRef.current = next;
    setGrid(next);
    return next !== current;
  };
  const reset = () => {
    setGrid(initialState());
    setDrafts({});
    setMedia(0);
    setActive("alpha");
  };
  useEffect(() => {
    window.__chatDragFixture = {
      getState: () => ({ grid, drafts, active, media }),
      setGrid,
      reset,
    };
    reportNativeDragState();
  });
  return (
    <AppChrome
      activeDestination="workspace"
      activeSessionId={active}
      activeWorkspaceLayout="thread"
      commandProfiles={[]}
      savedProjects={[]}
      sessions={sessions}
      pinnedSessionIds={[]}
      workspacePath={activeProjectKey}
      openChatSessionIds={layout.slots.flatMap((pane) =>
        pane?.kind === "session" ? [pane.sessionId] : [],
      )}
      onCreateCliSession={() => undefined}
      onCreateSession={() => undefined}
      onOpenCommandPalette={() => undefined}
      onOpenSettings={() => undefined}
      onOpenToolPanel={() => undefined}
      onOpenWorkspace={() => undefined}
      onSelectDestination={() => undefined}
      onSelectSession={setActive}
      onSelectSessions={() => undefined}
      onSelectWorkspaceLayout={() => undefined}
    >
      <div
        style={{
          height: "100%",
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
        }}
      >
        <nav
          aria-label="Splitview drag fixture controls"
          style={{
            padding: 10,
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            color: "var(--gyro-text)",
          }}
        >
          <strong>
            {isNativeDragSmoke
              ? "Gyro chat drag native"
              : "Splitview drag fixture"}
          </strong>
          <button onClick={reset}>Reset fixture</button>
          <button onClick={() => simulateDrop("beta", 0.98)}>
            Quick drop Beta right
          </button>
          <button
            disabled={!layout.slots.some(
              (pane) => pane?.kind === "session" && pane.sessionId === "beta",
            )}
            onClick={() => simulateDrop("beta", 0.4)}
          >
            Reorder Beta over Alpha
          </button>
          <button onClick={() => simulateDrop("gamma", 0.02, true)}>
            Hidden payload Gamma left
          </button>
          <button onClick={() => simulateDrop("alpha", 0.98, true)}>
            Move Alpha right
          </button>
          <button onClick={() => simulateDrop("beta", 0.98, true, true)}>
            Drop outside grid
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "set-arrangement",
                projectKey: activeProjectKey,
                arrangement: "rows",
              })
            }
          >
            Stack chats
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "set-arrangement",
                projectKey: activeProjectKey,
                arrangement: "grid",
              })
            }
          >
            Grid chats
          </button>
          <button
            onClick={() =>
              layout.focusedPaneId &&
              dispatch({
                type: "toggle-maximize-pane",
                paneId: layout.focusedPaneId,
              })
            }
          >
            Maximize focused
          </button>
          <output aria-live="polite">
            Order:{" "}
            {layout.slots
              .flatMap((pane) =>
                pane?.kind === "session" ? [pane.sessionId] : [],
              )
              .join(", ")}{" "}
            · Media drops: {media}
          </output>
        </nav>
        <ChatGridSurface
          layout={layout}
          maximizedPaneId={grid.maximizedPaneId}
          onFocusPane={(pane) => {
            dispatch({
              type: "focus-pane",
              projectKey: activeProjectKey,
              paneId: pane.paneId,
            });
          }}
          onMovePane={(paneId, slotIndex, placement) =>
            dispatch({
              type: "move-pane",
              projectKey: activeProjectKey,
              paneId,
              slotIndex,
              ...placement,
            })
          }
          onToggleMaximize={(paneId) => {
            dispatch({ type: "toggle-maximize-pane", paneId });
          }}
          onDropSession={(sessionId, _source, slotIndex, placement) => {
            const session = sessions.find((item) => item.id === sessionId);
            if (!session) return false;
            const targetProject = chatProjectKey(session.workspacePath);
            const switching = targetProject !== activeProjectKey;
            const existing = gridRef.current.layouts[targetProject]?.slots.some(
              (pane) =>
                pane?.kind === "session" && pane.sessionId === sessionId,
            );
            const accepted = dispatch({
              type: "select-pane",
              projectKey: targetProject,
              pane: paneFor(sessionId, session.workspacePath),
              mode: switching && existing ? "replace" : "drop",
              slotIndex: switching ? undefined : slotIndex,
              ...(switching ? {} : placement),
            });
            if (accepted) setActive(sessionId);
            return accepted;
          }}
          renderPane={(pane, options) => (
            <ChatSurface
              config={config}
              events={[
                {
                  id: `request-${pane.paneId}`,
                  sessionId: pane.kind === "session" ? pane.sessionId : "",
                  kind: "user-message",
                  createdAt: "2026-10-10T10:00:00Z",
                  message: "Verify splitview drag and drop.",
                  payload: {},
                },
              ]}
              sessionTitle={
                sessions.find(
                  (session) =>
                    session.id ===
                    (pane.kind === "session" ? pane.sessionId : ""),
                )?.title
              }
              workspacePath={pane.workspacePath}
              paneKey={pane.paneId}
              isTiled={options.isTiled}
              isEnvironmentRailOpen
              onPaneDragStart={options.onPaneDragStart}
              onPaneDragEnd={options.onPaneDragEnd}
              onPanePointerDown={options.onPanePointerDown}
              draft={drafts[pane.paneId] ?? ""}
              onDraftChange={(draft) =>
                setDrafts((current) => ({ ...current, [pane.paneId]: draft }))
              }
              onAttachMediaFiles={() => setMedia((count) => count + 1)}
              onCloseChat={() =>
                dispatch({
                  type: "close-pane",
                  projectKey: activeProjectKey,
                  paneId: pane.paneId,
                })
              }
              onComposerAction={() => undefined}
              onSend={() => undefined}
            />
          )}
        />
      </div>
    </AppChrome>
  );
}
if (import.meta.env.DEV || isNativeDragSmoke) {
  document.documentElement.dataset.theme = "light";
  createRoot(document.getElementById("root")!).render(<Preview />);
}
