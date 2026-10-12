// Development-only recovery preview. Provider calls are replaced by local state.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatRetryContext,
  ChatRun,
  ChatSurface,
  type RunModel,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.density =
  params.get("density") ?? "comfortable";
document.documentElement.dataset.interfaceSize =
  params.get("size") ?? "default";
if (params.has("accent")) {
  document.documentElement.style.setProperty(
    "--gyro-user-main",
    params.get("accent")!,
  );
}

type FixtureState =
  "scheduled" | "cancelled" | "permanent" | "interrupted" | "retrying" | "done";
const initialState = (params.get("state") ?? "scheduled") as FixtureState;
const eventId = "fixture-failed-status";
const requestedSeconds = Number(params.get("seconds") ?? "30");
const waitMs =
  (Number.isFinite(requestedSeconds) ? Math.max(1, requestedSeconds) : 30) *
  1_000;
const startedAt = new Date(Date.now() - 5_000).toISOString();
const steps: RunModel["steps"] = [
  {
    kind: "say",
    id: "fixture-narration",
    at: startedAt,
    text: "I will inspect the existing components, update the recovery notice, and check the result in both themes.",
  },
];

function Fixture() {
  const [state, setState] = useState<FixtureState>(initialState);
  const [pending, setPending] = useState<Record<string, { retryAt: number }>>(
    (): Record<string, { retryAt: number }> =>
      initialState === "scheduled"
        ? { [eventId]: { retryAt: Date.now() + waitMs } }
        : {},
  );
  const [action, setAction] = useState("");
  const [counts, setCounts] = useState({
    retries: 0,
    cancels: 0,
    reconnects: 0,
  });
  const deadline = pending[eventId]?.retryAt;
  useEffect(() => {
    const fixtureWindow = window as Window & {
      __gyroRetryFixture?: { getState: () => unknown };
    };
    fixtureWindow.__gyroRetryFixture = {
      getState: () => ({ state, pending, ...counts }),
    };
  }, [state, pending, counts]);
  // This is the fixture's host simulation, not a scheduler inside ChatRun.
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = window.setTimeout(
      () => {
        setPending({});
        setState("retrying");
        setAction("Automatic retry started");
        setCounts((current) => ({ ...current, retries: current.retries + 1 }));
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [deadline]);

  const model: RunModel = {
    startedAt,
    steps,
    files: [],
    phase:
      state === "interrupted"
        ? { name: "interrupted" }
        : state === "retrying"
          ? { name: "retrying", reason: "Waiting for the provider" }
          : state === "done"
            ? { name: "done", durationMs: 5_000 }
            : state === "permanent"
              ? {
                  name: "failed",
                  message:
                    "The provider needs to be signed in before this message can continue.",
                  recoveryKind: "authentication",
                  recoveryMessage: "The conversation context is preserved.",
                }
              : {
                  name: "failed",
                  message:
                    "Selected model is at capacity. Please try a different model.",
                  recoveryKind: "model-capacity",
                  recoveryMessage:
                    "Retry the message. Gyro will preserve the conversation context.",
                },
  };
  return (
    <ChatRetryContext.Provider
      value={{
        pending,
        cancel: () => {
          if (deadline === undefined) return;
          setPending({});
          setState("cancelled");
          setAction("Automatic retry cancelled");
          setCounts((current) => ({
            ...current,
            cancels: current.cancels + 1,
          }));
        },
      }}
    >
      <main
        style={{
          background: "var(--gyro-app)",
          color: "var(--gyro-text)",
          fontFamily: "var(--gyro-font-sans)",
          minHeight: "100vh",
          padding: "var(--gyro-space-section)",
          boxSizing: "border-box",
        }}
      >
        <nav
          aria-label="Fixture controls"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--gyro-space-standard)",
            marginBottom: "var(--gyro-space-section)",
          }}
        >
          <button
            className="gyro-secondary-button"
            type="button"
            onClick={() => {
              setState("scheduled");
              setPending({ [eventId]: { retryAt: Date.now() + 30_000 } });
              setAction("");
            }}
          >
            Reset 30s retry
          </button>
          <output
            data-testid="retry-fixture-action"
            style={{
              alignSelf: "center",
              color: "var(--gyro-muted)",
              fontSize: "var(--gyro-font-micro)",
            }}
          >
            Fixture · invented turn data{action ? ` · ${action}` : ""}
          </output>
        </nav>
        <section
          className="gyro-chat-surface is-thread"
          style={{
            height: "auto",
            maxWidth: params.has("narrow") ? 360 : 780,
            margin: "40px auto 0",
            overflow: "visible",
            padding: 0,
          }}
        >
          <div className="gyro-chat-turn">
            <div className="gyro-chat-run">
              <ChatRun
                model={model}
                recoveryEventId={eventId}
                onRetry={
                  state === "permanent"
                    ? undefined
                    : () => {
                        setPending({});
                        setState("retrying");
                        setAction("Manual retry started");
                        setCounts((current) => ({
                          ...current,
                          retries: current.retries + 1,
                        }));
                      }
                }
                onReconnect={
                  state === "permanent"
                    ? () => {
                        setAction("Sign in requested");
                        setCounts((current) => ({
                          ...current,
                          reconnects: current.reconnects + 1,
                        }));
                      }
                    : undefined
                }
                reconnectLabel="Sign in"
              />
            </div>
          </div>
        </section>
      </main>
    </ChatRetryContext.Provider>
  );
}

function NativeRetryFixture() {
  const [state, setState] = useState(params.get("state") ?? "native-wait");
  const [retryAt, setRetryAt] = useState<number | undefined>(() =>
    state === "native-wait" ? Date.now() + waitMs : undefined,
  );
  const [counts, setCounts] = useState({
    retries: 0,
    cancels: 0,
    approvals: 0,
  });
  const [action, setAction] = useState("");
  const [draft, setDraft] = useState("");
  const [lastStatusAction, setLastStatusAction] = useState<{
    action: string;
    eventId: string;
  }>();
  const isWaiting = state === "native-wait";
  const isCancelled = state === "native-cancelled";
  const isExhausted = state === "native-exhausted";
  const isDone = state === "native-done";
  useEffect(() => {
    const fixtureWindow = window as Window & {
      __gyroRetryFixture?: { getState: () => unknown };
    };
    fixtureWindow.__gyroRetryFixture = {
      getState: () => ({
        state,
        pending: {},
        nativeRetry: isWaiting
          ? { retryAt, attempt: 1, maxAttempts: 3 }
          : undefined,
        ...counts,
        lastStatusAction,
      }),
    };
  }, [state, retryAt, isWaiting, counts, lastStatusAction]);
  useEffect(() => {
    if (!isWaiting || retryAt === undefined) return;
    const timer = window.setTimeout(
      () => {
        setRetryAt(undefined);
        setState("native-resumed");
        setAction("Native continuation started");
        setCounts((current) => ({ ...current, retries: current.retries + 1 }));
      },
      Math.max(0, retryAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [isWaiting, retryAt]);
  const event = (
    id: string,
    kind: SessionEvent["kind"],
    message: string,
    payload: SessionEvent["payload"] = {},
  ): SessionEvent => ({
    id,
    kind,
    message,
    payload,
    sessionId: "native-fixture",
    turnId: "native-turn",
    createdAt: startedAt,
  });
  const events: SessionEvent[] = [
    event(
      "native-user",
      "user-message",
      "Continue the existing turn when the model becomes available.",
    ),
    event("native-tool", "system-event", "Ran tests", {
      kind: "provider-activity",
      activityKind: "command",
      activityId: "native-tool",
      label: "Ran tests",
      detail: "pnpm test",
      status: "done",
      timelineSequence: 1,
    }),
    event("native-file", "system-event", "Updated recovery.ts", {
      kind: "provider-activity",
      activityKind: "file",
      activityId: "native-file",
      label: "Updated file",
      path: "src/recovery.ts",
      status: "done",
      timelineSequence: 2,
    }),
    event(
      "native-approval",
      "approval-requested",
      "Verify the recorded change",
      {
        kind: "provider-tool-approval",
        approvalId: "native-approval",
        approvalType: "command",
        command: "pnpm test",
        providerLabel: "Fixture agent",
        status: isCancelled
          ? "cancelled"
          : isDone || counts.approvals > 0
            ? "approved"
            : "pending",
        timelineSequence: 3,
      },
    ),
    event(
      "native-status",
      "system-event",
      isExhausted
        ? "Model capacity retries exhausted"
        : isCancelled
          ? "Stopped"
          : "Working",
      {
        kind: "provider-status",
        status: isCancelled
          ? "cancelled"
          : isExhausted
            ? "failed"
            : isDone
              ? "done"
              : "running",
        providerId: "openai",
        startedAt,
        ...(isDone ? { durationMs: 5_000 } : {}),
        ...(isWaiting && retryAt !== undefined
          ? {
              nativeRetry: true,
              retryAt: new Date(retryAt).toISOString(),
              retryAttempt: 1,
              retryMaxAttempts: 3,
              recoveryKind: "model-capacity",
            }
          : {}),
        ...(isExhausted
          ? {
              recoveryKind: "model-capacity-exhausted",
              error:
                "Selected model is at capacity after 3 automatic retries. Recorded work is preserved. Retry or choose a different model.",
            }
          : {}),
        ...(isCancelled ? { recoveryKind: "cancelled" } : {}),
      },
    ),
  ];
  if (isDone)
    events.splice(
      events.length - 1,
      0,
      event(
        "native-answer",
        "assistant-message",
        "The existing turn finished successfully. Recorded changes and verification are preserved.",
        { kind: "provider-response", status: "done", timelineSequence: 4 },
      ),
    );
  return (
    <main
      style={{
        background: "var(--gyro-app)",
        color: "var(--gyro-text)",
        minHeight: "100vh",
        padding: "var(--gyro-space-section)",
        boxSizing: "border-box",
        fontFamily: "var(--gyro-font-sans)",
      }}
    >
      <nav
        aria-label="Fixture controls"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--gyro-space-standard)",
          marginBottom: "var(--gyro-space-section)",
        }}
      >
        <button
          className="gyro-secondary-button"
          type="button"
          onClick={() => {
            setState("native-wait");
            setRetryAt(Date.now() + 30_000);
            setAction("");
          }}
        >
          Reset native 30s wait
        </button>
        {state === "native-resumed" ? (
          <button
            className="gyro-secondary-button"
            type="button"
            onClick={() => {
              setState("native-done");
              setAction("Native turn completed");
            }}
          >
            Finish native turn
          </button>
        ) : null}
        <output
          data-testid="retry-fixture-action"
          style={{
            color: "var(--gyro-muted)",
            fontSize: "var(--gyro-font-micro)",
            alignSelf: "center",
          }}
        >
          Fixture · native continuation{action ? ` · ${action}` : ""}
        </output>
      </nav>
      <div
        style={{
          width: "100%",
          maxWidth: params.has("narrow") ? 360 : 780,
          height: 660,
          margin: "0 auto",
        }}
      >
        <ChatSurface
          events={events}
          config={{
            commandProfiles: [],
            modelProviders: [],
            requireCommandApproval: true,
            requireFileEditApproval: true,
            telemetryEnabled: false,
          }}
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => {}}
          isComposerSending={!isCancelled && !isExhausted && !isDone}
          onProviderStatusAction={(statusAction, statusEvent) => {
            setLastStatusAction({
              action: statusAction,
              eventId: statusEvent.id,
            });
            if (statusAction === "cancel-retry" && isWaiting) {
              setRetryAt(undefined);
              setState("native-cancelled");
              setAction("Native retry cancelled");
              setCounts((current) => ({
                ...current,
                cancels: current.cancels + 1,
              }));
            } else if (statusAction === "retry-send" && isExhausted) {
              setState("native-resumed");
              setAction("Manual continuation started");
              setCounts((current) => ({
                ...current,
                retries: current.retries + 1,
              }));
            }
          }}
          onProviderApprovalAction={() => {
            setAction("Approval allowed once");
            setCounts((current) => ({
              ...current,
              approvals: current.approvals + 1,
            }));
          }}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  params.get("state")?.startsWith("native-") ? (
    <NativeRetryFixture />
  ) : (
    <Fixture />
  ),
);
