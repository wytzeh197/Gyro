// Development-only check of the real Review surface at companion rail width.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DiffReviewSurface, type DiffReview } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
const files: DiffReview["files"] = [{
  path: "src/chat.ts", additions: 1, deletions: 1, source: "agent-generated", state: "pending", comments: 0,
  lines: [
    { number: 12, kind: "context", content: "function openChat(session) {" },
    { number: 13, kind: "removed", content: "  scrollToBeginning(session);" },
    { number: 13, kind: "added", content: "  scrollToNewestMessage(session, { waitForHistory: true, preserveManualScroll: true });" },
    { number: 14, kind: "context", content: "}" },
  ],
}, { path: "README.md", additions: 1, deletions: 0, source: "agent-generated", state: "pending", comments: 0,
  lines: [{ number: 1, kind: "added", content: "Opening an existing chat shows the newest message." }],
}];
function Fixture() {
  const [selectedPath, select] = useState("src/chat.ts");
  return <div style={{ width: "calc(100vw - 24px)", maxWidth: 380, height: "95vh", margin: 12 }}>
    <aside className="gyro-environment-rail is-tool is-chromeless" style={{ display: "grid", position: "relative", inset: "auto", transform: "none", width: "100%", height: "100%" }}>
      <DiffReviewSurface compact diffReview={{ files, selectedPath, approvalState: "pending", commitMessage: "", collapsedDirectories: [], gitActions: [] }} onSelectFile={select} />
    </aside>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
