// Build-only acceptance entry: seed disposable UI state, then run the actual
// application entrypoint and its normal native commands and chat callbacks.
// This entry is excluded from ordinary release builds.
type NativeChatDragSeed = {
  dataDir: string;
  workspacePath: string;
  sessions: Array<{ id: string; title: string; draft: string }>;
};

if (
  import.meta.env.MODE !== "native-chat-drag-main" ||
  !("__TAURI_INTERNALS__" in window)
) {
  throw new Error("The full-app drag acceptance entry requires native WebKit.");
}

const seed = JSON.parse(
  import.meta.env.VITE_GYRO_NATIVE_CHAT_DRAG_MAIN_SEED,
) as NativeChatDragSeed;
if (!seed.dataDir.startsWith("/private/") || seed.sessions.length !== 5) {
  throw new Error("The native acceptance seed is missing or invalid.");
}
const first = seed.sessions[0]!;
const paneId = `session:${first.id}`;
localStorage.setItem("gyro.theme", "dark");
localStorage.setItem("gyro.system-access-prompted-v1", "true");
localStorage.setItem(
  "gyro.recent-project-paths",
  JSON.stringify([seed.workspacePath]),
);
localStorage.setItem(
  "gyro.workbench-state",
  JSON.stringify({
    activeDestination: "workspace",
    activeWorkspaceLayout: "thread",
    lastSessionsLayout: "thread",
    isToolPanelOpen: false,
    onboarding: {
      activeStep: "first-session",
      completedSteps: [
        "account",
        "welcome",
        "theme",
        "system-access",
        "workspace",
        "provider",
        "approval",
        "first-session",
      ],
    },
  }),
);
localStorage.setItem(
  "gyro.chat-drafts-v1",
  JSON.stringify(
    Object.fromEntries(
      seed.sessions.map((session) => [session.id, session.draft]),
    ),
  ),
);
localStorage.setItem(
  "gyro.chat-grid-layouts-v1",
  JSON.stringify({
    activeProjectKey: seed.workspacePath,
    layouts: {
      [seed.workspacePath]: {
        projectKey: seed.workspacePath,
        focusedPaneId: paneId,
        slots: [
          {
            paneId,
            kind: "session",
            sessionId: first.id,
            workspacePath: seed.workspacePath,
          },
          null,
          null,
          null,
        ],
      },
    },
  }),
);

void import("./main");
