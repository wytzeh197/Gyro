// Development-only check of the real Review surface at companion rail width.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DiffReviewSurface,
  GitComparisonReview,
  ChatSurface,
  applyAppearancePreferences,
  type ChatSidePanelId,
  type SessionEvent,
  type DiffReview,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
const files: DiffReview["files"] = [
  {
    path: "src/chat.ts",
    additions: 1,
    deletions: 1,
    source: "agent-generated",
    state: "pending",
    comments: 0,
    lines: [
      { number: 12, kind: "context", content: "function openChat(session) {" },
      { number: 13, kind: "removed", content: "  scrollToBeginning(session);" },
      {
        number: 13,
        kind: "added",
        content:
          "  scrollToNewestMessage(session, { waitForHistory: true, preserveManualScroll: true });",
      },
      { number: 14, kind: "context", content: "}" },
    ],
  },
  {
    path: "README.md",
    additions: 1,
    deletions: 0,
    source: "agent-generated",
    state: "pending",
    comments: 0,
    lines: [
      {
        number: 1,
        kind: "added",
        content: "Opening an existing chat shows the newest message.",
      },
    ],
  },
];
const params = new URLSearchParams(location.search);
const previewTheme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = previewTheme;
document.documentElement.dataset.density =
  params.get("density") === "compact" ? "compact" : "comfortable";
applyAppearancePreferences(
  document.documentElement,
  {
    interfaceSize:
      params.get("size") === "large"
        ? "large"
        : params.get("size") === "small"
          ? "small"
          : "default",
    mainColor: "#0874df",
    secondaryColor: "#8b6fcb",
    motionSpeed: "default",
  },
  previewTheme,
);
const comparisonFiles = [
  { path: "apps/desktop/src-tauri/src/lib.rs", additions: 3, deletions: 3 },
  {
    path: "apps/desktop/src-tauri/src/openai_compatible_runner.rs",
    additions: 115,
    deletions: 8,
  },
  {
    path: "crates/gyro-core/src/provider_registry.rs",
    additions: 2,
    deletions: 3,
  },
  { path: "packages/ui/src/provider-catalog.ts", additions: 1, deletions: 1 },
];
const loadDiff = async (file: { path: string }) => ({
  original: "",
  modified: "",
  unified: file.path.endsWith("lib.rs")
    ? [
        "@@ -6072,5 +6072,5 @@ fn provider_context_message_for_turn(",
        "         request,",
        "         conversation_history,",
        "-        provider_descriptor(&request.provider_id).is_some_and(|provider| provider.supports_images),",
        "+        openai_compatible_runner::supports_images(request),",
        "         turn,",
        "     )",
        "@@ -13607,3 +13607,3 @@ fn run_provider_chat_once(",
        "     let expanded = with_browser_attachment_images(",
        "-        request, false,",
        "+        request, openai_compatible_runner::supports_images(request),",
        "     )?;",
      ].join("\n")
    : [
        "@@ -1,3 +1,3 @@",
        " // " + file.path,
        "-supports_images: false,",
        "+supports_images: true,",
        " // Model support is checked before sending.",
      ].join("\n"),
});
const recordedFiles = comparisonFiles.map((file) => ({
  ...file,
  patches: params.has("no-patches")
    ? []
    : Array.from({ length: params.has("many-edits") ? 8 : 2 }, (_, index) =>
        [
          `@@ -1,3 +1,3 @@ Recorded edit ${index + 1}`,
          ` // ${file.path}`,
          `-const revision = ${index};`,
          `+const revision = ${index + 1};`,
          " // Recorded from this turn, not the current working tree.",
        ].join("\n"),
      ),
}));
function Fixture() {
  const [selectedPath, select] = useState("src/chat.ts");
  const [chatPanel, setChatPanel] = useState<ChatSidePanelId | undefined>(
    "review",
  );
  if (params.get("mode") === "chat") {
    const base = {
      sessionId: "review-chat",
      turnId: "recorded-turn",
      createdAt: "2026-10-07T12:00:00Z",
      payload: {},
    };
    const events: SessionEvent[] = [
      {
        ...base,
        id: "user",
        kind: "user-message",
        message: "Update the image support check.",
      },
      {
        ...base,
        id: "file",
        kind: "system-event",
        message: "Edited lib.rs",
        payload: {
          kind: "provider-activity",
          activityKind: "file",
          status: "done",
          path: recordedFiles[0]!.path,
          additions: 3,
          deletions: 3,
        },
      },
      {
        ...base,
        id: "receipt",
        kind: "system-event",
        message: "Applied edit",
        payload: {
          schema: "gyro.mutation.v1",
          status: "applied",
          fileChanges: [
            {
              path: recordedFiles[0]!.path,
              patch: recordedFiles[0]!.patches[0],
            },
          ],
        },
      },
      {
        ...base,
        id: "answer",
        kind: "assistant-message",
        message: "Updated the image support check.",
      },
    ];
    return (
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <nav aria-label="Fixture controls">
          <button
            onClick={() => setChatPanel(chatPanel ? undefined : "review")}
          >
            {chatPanel ? "Hide review" : "Open review"}
          </button>
        </nav>
        <ChatSurface
          config={{
            commandProfiles: [],
            modelProviders: [],
            requireCommandApproval: true,
            requireFileEditApproval: true,
            telemetryEnabled: false,
          }}
          onSend={() => {}}
          shellReady
          events={events}
          activeChatPanel={chatPanel}
          onSelectChatPanel={setChatPanel}
          onLoadComparisonDiff={loadDiff}
          onLoadChangeDiff={async (path) => (await loadDiff({ path })).unified}
        />
      </div>
    );
  }
  return (
    <div
      className="gyro-chat-companion-content"
      style={{
        width: "calc(100vw - 24px)",
        maxWidth: Number(params.get("width")) || 720,
        height: "95vh",
        margin: 12,
      }}
    >
      <aside
        className="gyro-environment-rail is-tool is-chromeless"
        style={{
          display: "grid",
          position: "relative",
          inset: "auto",
          transform: "none",
          width: "100%",
          height: "100%",
        }}
      >
        {params.get("mode") === "proposed" ? (
          <DiffReviewSurface
            compact
            collapsibleFiles
            diffReview={{
              files,
              selectedPath,
              approvalState: "pending",
              commitMessage: "",
              collapsedDirectories: [],
              gitActions: [],
            }}
            onSelectFile={select}
          />
        ) : (
          <GitComparisonReview
            scope={{ kind: "turn", turnId: "fixture" }}
            turnFiles={params.has("empty") ? [] : recordedFiles}
            onLoadDiff={loadDiff}
          />
        )}
      </aside>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
