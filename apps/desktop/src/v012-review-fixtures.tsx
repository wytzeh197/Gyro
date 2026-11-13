// Synthetic production-component evidence; no native/provider commands.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CodeReviewPanel,
  applyAppearancePreferences,
  type CodeReviewRuntime,
  type CodeReviewRun,
  type CodeReviewSnapshot,
  type ReviewerSetup,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.density =
  params.get("density") === "compact" ? "compact" : "comfortable";
applyAppearancePreferences(
  document.documentElement,
  {
    interfaceSize: params.get("scale") === "large" ? "large" : "default",
    mainColor: "#ffffff",
    secondaryColor: "#ffffff",
    motionSpeed: "default",
  },
  theme,
);
const snapshot: CodeReviewSnapshot = {
  id: "snapshot-fixture",
  rootId: "root-gyro",
  rootPath: "/fixture/Gyro",
  scope: { kind: "uncommitted" },
  request: "Return the expected sum for the caller.",
  capturedAt: "2026-11-10T12:00:00Z",
  capturedBytes: 82,
  manifestHash: "fixture1234abcd5678",
  files: [
    {
      path: "src/value.rs",
      status: "modified",
      originalHash: "original",
      modifiedHash: "modified",
    },
  ],
  exclusions:
    params.get("state") === "incomplete"
      ? [{ path: "asset.bin", reason: "Binary content excluded" }]
      : [],
};
const setup: ReviewerSetup = {
  rootId: "root-gyro",
  roots: [{ id: "root-gyro", path: "/fixture/Gyro" }],
  reviewers: [
    {
      id: "api-fixture",
      label: "Review API",
      transport: "API",
      available: true,
      modelIds: ["review-model"],
      defaultModelId: "review-model",
    },
    {
      id: "cli-fixture",
      label: "CLI fixture",
      transport: "CLI",
      available: false,
      reason: "No-tool review unavailable for this adapter",
      modelIds: [],
    },
  ],
};
let runs: CodeReviewRun[] = [];
const calls: string[] = [];
Object.assign(window, { reviewFixture: { calls } });
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((callback) => callback());
const clone = <T,>(value: T): T => structuredClone(value);
let fixIntents: {
  id: string;
  revision: number;
  status: string;
  turnId: string;
  providerId: string;
  modelId: string;
}[] = [];
const runtime: CodeReviewRuntime = {
  key: "review-fixture",
  subscribe: (callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
  request: async <T,>(action: string, payload?: unknown): Promise<T> => {
    calls.push(action);
    const data = (payload ?? {}) as Record<string, unknown>;
    if (params.get("state") === "error" && action === "reviewers")
      throw Error("Fixture: project unavailable. Reopen it and retry.");
    let result: unknown;
    switch (action) {
      case "reviewers":
        result = setup;
        break;
      case "list":
        result = runs;
        break;
      case "discard-previews":
        result = { discarded: 1 };
        break;
      case "capture":
        result = snapshot;
        break;
      case "preview":
      case "input":
        result = {
          input: JSON.stringify(
            { request: snapshot.request, files: snapshot.files },
            null,
            2,
          ),
        };
        break;
      case "start": {
        const state = params.get("state");
        const status =
          state === "busy"
            ? "running"
            : state === "incomplete"
              ? "incomplete"
              : "completed";
        const run: CodeReviewRun = {
          id: `review-${runs.length}`,
          revision: 1,
          rootId: snapshot.rootId,
          snapshotId: snapshot.id,
          status,
          providerId: "api-fixture",
          modelId: "review-model",
          createdAt: "2026-11-10T12:01:00Z",
          summary:
            state === "zero"
              ? "No concrete fault reported."
              : "A return value breaks the documented caller.",
          findings:
            state === "zero"
              ? []
              : [
                  {
                    id: "finding-return",
                    revision: 1,
                    path: "src/value.rs",
                    side: "modified",
                    lineStart: 2,
                    lineEnd: 2,
                    severity: "P1",
                    title: "Return the expected value",
                    explanation:
                      "The caller expects 1 for this input, so returning 2 produces a wrong result.",
                    suggestedResolution:
                      "Use the specified arithmetic and verify the caller's case.",
                    disposition: "open",
                  },
                ],
          limitations:
            state === "incomplete" ? ["One binary file was excluded."] : [],
          suppliedFiles: 1,
          intendedFiles: state === "incomplete" ? 2 : 1,
        };
        runs = [run, ...runs];
        result = run;
        changed();
        break;
      }
      case "get":
        result = {
          run: runs.find((run) => run.id === data.reviewId),
          snapshot,
          freshness:
            params.get("state") === "stale" ? "source-changed" : "current",
          targetFingerprint: "fixture-current-fingerprint",
          fixTarget: { providerId: "cli-fixture", modelId: "cli-model" },
          fixIntents,
        };
        break;
      case "file":
        result = {
          diff: "--- original\n+++ modified\n@@ -1,3 +1,3 @@\n fn value() -> i32 {\n-    1\n+    2\n }\n",
        };
        break;
      case "raw":
        result = {
          output: "Fixture review output; no provider call was made.",
        };
        break;
      case "dismiss":
        runs = runs.map((run) =>
          run.id === data.reviewId
            ? {
                ...run,
                revision: run.revision + 1,
                findings: run.findings.map((finding) =>
                  finding.id === data.findingId
                    ? { ...finding, disposition: "dismissed" as const }
                    : finding,
                ),
              }
            : run,
        );
        result = runs[0];
        changed();
        break;
      case "cancel":
        runs = runs.map((run) =>
          run.id === data.reviewId
            ? { ...run, status: "cancelled", revision: run.revision + 1 }
            : run,
        );
        result = runs[0];
        changed();
        break;
      case "delete":
        runs = runs.filter((run) => run.id !== data.reviewId);
        result = { deleted: true };
        changed();
        break;
      case "send-fixes":
        fixIntents = [
          {
            id: "fix-operation",
            revision: 1,
            status: "queued",
            turnId: "implementing-turn-fixture",
            providerId: "cli-fixture",
            modelId: "cli-model",
          },
        ];
        result = fixIntents[0];
        changed();
        break;
      case "cancel-fixes":
        fixIntents = fixIntents.map((intent) => ({
          ...intent,
          status: "cancelled",
          revision: 2,
        }));
        result = fixIntents[0];
        changed();
        break;
      case "fix-draft":
        result = {
          message:
            "Address the selected fixture finding under the current project permissions. Inspect current files before editing.",
        };
        break;
      default:
        throw Error(`Unsupported fixture action ${action}`);
    }
    return clone(result) as T;
  },
};
function Fixture() {
  const [draft, setDraft] = useState("");
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--gyro-app)",
        color: "var(--gyro-text)",
      }}
    >
      <p style={{ padding: "8px", margin: 0 }}>
        v0.1.2 · synthetic review data
      </p>
      <div
        style={{
          height: "calc(100vh - 55px)",
          width: Number(params.get("width")) || 420,
          maxWidth: "100%",
          borderRight: "1px solid var(--gyro-border)",
          overflow: "hidden",
        }}
      >
        <CodeReviewPanel
          runtime={runtime}
          entry={
            params.get("entry") === "turn"
              ? {
                  token: 1,
                  scope: { kind: "turn", turnId: "source-turn-fixture" },
                }
              : params.get("entry") === "workspace"
                ? {
                    token: 1,
                    scope: { kind: "uncommitted" },
                    rootId: "root-gyro",
                  }
                : undefined
          }
          scope={{ kind: "working-tree" }}
          changes={<p>Existing Changes view</p>}
          onComposeFix={(message) => {
            if (draft) return false;
            setDraft(message);
            return true;
          }}
        />
      </div>
      <output data-fix-draft style={{ display: draft ? "block" : "none" }}>
        {draft}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
