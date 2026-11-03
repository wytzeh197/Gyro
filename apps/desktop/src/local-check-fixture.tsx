// UI/transport fixture only. It never executes a command or calls Tauri.
import { useContext } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckWorkStatus,
  CheckWorkContext,
  setConfirmActionHandler,
} from "@gyro-dev/ui";
import { LocalCheckHost } from "./local-check";
import type { CheckDraft, CheckPlan, CheckReport } from "./local-check-types";
import "@gyro-dev/ui/styles.css";

const session = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Add a to-do item and reject an empty title",
  workspacePath: "/fixture/gyro-check",
};
let reports: CheckReport[] = [];
let pending: CheckPlan | undefined;
let finishRunning: (() => void) | undefined;
let completeRunning: (() => void) | undefined;
const calls: string[] = [];
const cloudCalls: Record<string, unknown>[] = [];
let queueReport = false;
let failShare = false;
let reportUpload:
  { requestId: string; objectId: string; revisionId: string } | undefined;
const reportTickets = new Set<string>();
const cloudRequest = async (
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  cloudCalls.push(structuredClone(request));
  if (request.operation === "preview-report") {
    if (
      !reports.some(
        (report) =>
          report.plan.id === request.reportId &&
          report.plan.draft.sessionId === request.localId,
      )
    )
      throw new Error("Report not found");
    const ticket = crypto.randomUUID();
    reportTickets.add(ticket);
    const content =
      "Gyro Check report\nUI fixture · simulated transport\nPassed: Add a to-do item\nRequired evidence: API responses\nLimits: Browser interaction was not checked.\n[local path removed]\nRead-only report; no execution permissions.";
    return {
      ticket,
      kind: "report",
      content,
      sizeBytes: new TextEncoder().encode(content).length,
    };
  }
  if (request.operation === "upload-preview") {
    if (
      request.reviewed !== true ||
      typeof request.ticket !== "string" ||
      !reportTickets.delete(request.ticket)
    )
      throw new Error("Unreviewed or expired ticket");
    reportUpload = {
      requestId: crypto.randomUUID(),
      objectId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
    };
    return queueReport
      ? { queued: true, requestId: reportUpload.requestId }
      : {
          queued: false,
          requestId: reportUpload.requestId,
          uploaded: reportUpload,
          completed: [reportUpload],
        };
  }
  const command = request.command as Record<string, unknown> | undefined;
  if (request.operation === "service" && command?.operation === "retry-uploads")
    return { queued: false, completed: reportUpload ? [reportUpload] : [] };
  if (
    request.operation === "service" &&
    command?.operation === "create-share"
  ) {
    if (failShare) throw new Error("Simulated ambiguous share response");
    if (
      !reportUpload ||
      command.objectId !== reportUpload.objectId ||
      command.revisionId !== reportUpload.revisionId ||
      command.expiresInDays !== 7
    )
      throw new Error("Wrong upload acknowledgment");
    return {
      shareId: crypto.randomUUID(),
      url: "https://share.example/reports/synthetic-fixture",
      expiresAt: "2026-11-09T12:00:00Z",
    };
  }
  if (request.operation === "service" && command?.operation === "revoke-share")
    return { revoked: true };
  throw new Error("Unexpected Cloud fixture operation");
};
let executed = 0;
let stale = false;
setConfirmActionHandler(async () => true);

const call = async <T,>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  calls.push(name);
  if (name === "list_local_checks")
    return reports.map((r) => ({
      ...r,
      stale,
      freshnessNote: stale
        ? "Selected files changed. Run a new check."
        : "UI fixture snapshot matches.",
    })) as T;
  if (name === "prepare_local_check") {
    const draft = structuredClone(args!.draft) as CheckDraft;
    pending = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      workspaceRevision: 1,
      draft,
      snapshot: {
        workspace: session.workspacePath,
        gitHead: "0".repeat(40),
        files: draft.files.map((path) => ({ path, sha256: "a".repeat(64) })),
      },
    };
    return structuredClone(pending) as T;
  }
  if (name === "cancel_local_check") {
    finishRunning?.();
    return undefined as T;
  }
  if (name === "delete_local_check") {
    reports = reports.filter((r) => r.plan.id !== args!.reportId);
    return undefined as T;
  }
  if (name !== "resolve_local_check" || !pending || args!.planId !== pending.id)
    throw new Error("Unexpected fixture call");
  const plan = pending;
  pending = undefined;
  const approved = args!.decision === "approve";
  if (approved && !args!.testEnvironmentConfirmed)
    throw new Error("Fixture requires confirmation");
  let stopped = false;
  if (approved) {
    executed += 1;
    if (plan.draft.command.endsWith("slow"))
      await new Promise<void>((resolve) => {
        completeRunning = resolve;
        finishRunning = () => {
          stopped = true;
          resolve();
        };
      });
  }
  const unavailable = plan.draft.command.endsWith("unavailable");
  const broken = plan.draft.command.endsWith("broken");
  const report: CheckReport = {
    plan,
    finishedAt: new Date().toISOString(),
    stale: false,
    freshnessNote: "UI fixture snapshot matches.",
    omission:
      "UI fixture: simulated command transport and evidence. No native execution or live provider.",
    results: plan.draft.criteria.map((c, i) => ({
      criterionId: c.id,
      status:
        !approved || unavailable || stopped || c.scope !== "api"
          ? "not-checked"
          : broken && i === 1
            ? "failed"
            : "passed",
      reason: stopped
        ? "Check was cancelled."
        : unavailable
          ? "Preview server unavailable."
          : !approved
            ? `User chose ${String(args!.decision)}. No command ran.`
            : c.scope !== "api"
              ? "Returned API evidence does not cover the approved browser interaction requirement."
              : "Fixture observation compared with approved expected value.",
      ...(approved && !unavailable && !stopped
        ? { observedScope: "api" as const }
        : {}),
      ...(approved && !unavailable && !stopped && c.scope === "api"
        ? {
            actual: !(broken && i === 1),
            evidence: `UI fixture response: ${i === 0 ? "POST /todos 201; GET returned the item" : broken ? "POST empty title 201; count increased" : "POST empty title 400; count unchanged"}`,
          }
        : {}),
    })),
    ...(approved
      ? {
          output: {
            termination: {
              kind: stopped ? "cancelled" : "exited",
              code: unavailable ? 1 : 0,
            },
            stdout: "UI fixture stdout",
            stderr: unavailable ? "Preview unavailable" : "",
            durationMs: 100,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        }
      : {}),
  };
  reports.unshift(report);
  return structuredClone(report) as T;
};

Object.assign(window, {
  __gyroCheckFixture: {
    get calls() {
      return calls;
    },
    get cloudCalls() {
      return cloudCalls;
    },
    queueReport(value: boolean) {
      queueReport = value;
    },
    failShare(value: boolean) {
      failShare = value;
    },
    get executed() {
      return executed;
    },
    get reports() {
      return reports;
    },
    get pending() {
      return pending;
    },
    completeRunning() {
      completeRunning?.();
    },
    markStale() {
      stale = true;
    },
  },
});
document.documentElement.dataset.theme =
  new URL(location.href).searchParams.get("theme") || "light";
function FixtureContent() {
  const open = useContext(CheckWorkContext)!;
  return (
    <main
      style={{
        maxWidth: 920,
        margin: "0 auto",
        padding: "32px 24px",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      <header>
        <small>Local Check UI fixture · simulated transport only</small>
        <h2>To-do form validation</h2>
      </header>
      <p>Add a to-do item and reject an empty title.</p>
      <p>The changes are ready for a local check.</p>
      <button style={{ alignSelf: "start" }} onClick={() => open(session.id)}>
        Open Check
      </button>
      <div
        style={{
          marginTop: "auto",
          border: "1px solid var(--gyro-border)",
          borderRadius: 16,
          background: "var(--gyro-pane)",
        }}
      >
        <CheckWorkStatus sessionId={session.id} />
        <textarea
          aria-label="Chat message"
          placeholder="Ask a follow-up…"
          style={{
            width: "100%",
            padding: 16,
            boxSizing: "border-box",
            background: "transparent",
            color: "var(--gyro-text)",
            border: 0,
            resize: "none",
            font: "inherit",
          }}
        />
      </div>
      <div data-other-chat>
        <CheckWorkStatus sessionId="another-chat" />
      </div>
    </main>
  );
}
function Fixture() {
  return (
    <LocalCheckHost
      sessions={[session]}
      call={call}
      available
      cloudRequest={
        new URL(location.href).searchParams.has("sharing")
          ? cloudRequest
          : undefined
      }
    >
      <FixtureContent />
    </LocalCheckHost>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
