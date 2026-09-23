// Development-only check of the real Review surface at companion rail width.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DiffReviewSurface,
  GitComparisonReview,
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
document.documentElement.dataset.theme =
  params.get("theme") === "light" ? "light" : "dark";
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
function Fixture() {
  const [selectedPath, select] = useState("src/chat.ts");
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
            turnFiles={params.has("empty") ? [] : comparisonFiles}
            onLoadDiff={loadDiff}
          />
        )}
      </aside>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
