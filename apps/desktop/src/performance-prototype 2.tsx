import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRun } from "@gyro-dev/ui";
import type { RunModel } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import "./performance-prototype.css";

type State =
  | "idle"
  | "preparing"
  | "working"
  | "approval"
  | "stopped"
  | "failed"
  | "completed";
const labels: Record<State, string> = {
  idle: "Ready",
  preparing: "Preparing workspace",
  working: "Working",
  approval: "Awaiting approval",
  stopped: "Stopped",
  failed: "Needs attention",
  completed: "Completed",
};
const states = Object.keys(labels) as State[];
const params = new URLSearchParams(location.search);
const initial = params.get("state") as State;
const answer =
  "The retry loop now stops after five attempts, with a delay between retries. The final failure stays visible instead of being swallowed.";
const startedAt = new Date().toISOString();
const evidence = {
  inputToPaintMs: [] as number[],
  streamToPaintMs: [] as number[],
  stopToPaintMs: [] as number[],
};

function Prototype() {
  const [state, setState] = useState<State>(
    states.includes(initial) ? initial : "completed",
  );
  const [theme, setTheme] = useState(
    params.get("theme") === "dark" ? "dark" : "light",
  );
  const [long, setLong] = useState(params.get("history") === "long");
  const [input, setInput] = useState("");
  const [stream, setStream] = useState("");
  const [panel, setPanel] = useState("Review");
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(300);
  const [details, setDetails] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const marks = useRef<{ input?: number; stream?: number; stop?: number }>({});
  const running = state === "preparing" || state === "working";
  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const choose = (next: State) => {
    clear();
    setState(next);
    setStream("");
  };
  useEffect(() => () => clear(), []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.add("gyro-design-study");
  }, [theme]);
  useLayoutEffect(() => {
    for (const kind of ["input", "stream", "stop"] as const) {
      const at = marks.current[kind];
      if (at === undefined) continue;
      delete marks.current[kind];
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (document.visibilityState !== "visible") return;
          const key = `${kind}ToPaintMs` as keyof typeof evidence;
          if (evidence[key].length < 256)
            evidence[key].push(performance.now() - at);
          document.documentElement.dataset.studyMeasurements =
            JSON.stringify(evidence);
        }),
      );
    }
  }, [input, stream, state]);
  const start = () => {
    clear();
    setState("preparing");
    setStream("");
    timers.current.push(
      setTimeout(() => {
        setState("working");
        for (let i = 3; i <= answer.length + 3; i += 3)
          timers.current.push(
            setTimeout(() => {
              marks.current.stream = performance.now();
              setStream(answer.slice(0, i));
            }, i * 24),
          );
      }, 900),
    );
    timers.current.push(setTimeout(() => setState("completed"), 18000));
  };
  const stop = () => {
    marks.current.stop = performance.now();
    clear();
    setState("stopped");
  };
  const model: RunModel = {
    startedAt,
    phase:
      state === "failed"
        ? {
            name: "failed",
            message:
              "Connection lost after the edit. Review the existing change before continuing.",
          }
        : state === "stopped"
          ? {
              name: "failed",
              message: "chat cancelled by user",
              recoveryKind: "cancelled",
            }
          : state === "completed"
            ? { name: "done", durationMs: 18200 }
            : { name: state === "preparing" ? "thinking" : "working" },
    files:
      state === "preparing" || state === "idle"
        ? []
        : [
            {
              path: "src/sync.js",
              status: "done",
              additions: 24,
              deletions: 6,
            },
          ],
    steps:
      state === "preparing" || state === "idle"
        ? []
        : [
            {
              kind: "work",
              id: "read",
              at: startedAt,
              item: {
                kind: "read",
                id: "read",
                status: "done",
                path: "src/sync.js",
                media: "file",
              },
            },
            {
              kind: "work",
              id: "edit",
              at: startedAt,
              item: {
                kind: "file",
                id: "edit",
                status: "done",
                path: "src/sync.js",
                additions: 24,
                deletions: 6,
              },
            },
            ...(state === "completed" || state === "working"
              ? [
                  {
                    kind: "work" as const,
                    id: "test",
                    at: startedAt,
                    item: {
                      kind: "command" as const,
                      id: "test",
                      status:
                        state === "completed"
                          ? ("done" as const)
                          : ("running" as const),
                      command: "node --test src/sync.test.js",
                      category: "test" as const,
                      intent: "Check the retry limit",
                    },
                  },
                ]
              : []),
          ],
  };
  return (
    <>
      <nav id="gyro-study-controls" aria-label="Design study controls">
        <div className="gyro-study-title">
          <img src="/gyro-logo.png" alt="" />
          <strong>Gyro</strong>
          <span>Design study · Sample data</span>
        </div>
        <label>
          State{" "}
          <select
            aria-label="Preview state"
            value={state}
            onChange={(e) => choose(e.target.value as State)}
          >
            {states.map((s) => (
              <option key={s} value={s}>
                {labels[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Theme{" "}
          <select
            aria-label="Preview theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={long}
            onChange={(e) => setLong(e.target.checked)}
          />{" "}
          Long conversation
        </label>
        <button type="button" onClick={start}>
          Try streaming
        </button>
      </nav>
      <div className="study-workbench" data-state={state}>
        <aside className="study-sidebar" aria-label="Sidebar">
          <div className="study-window-controls" aria-hidden="true">
            <i />
            <i />
            <i />
            <span>‹　›</span>
          </div>
          <div className="study-mode">
            <button aria-pressed="true">Sessions</button>
            <button
              onClick={() => {
                setPanel("Files");
                setPanelOpen(true);
              }}
            >
              Workspace
            </button>
          </div>
          <button className="study-nav" onClick={() => choose("idle")}>
            ＋ <span>New Session</span>
          </button>
          <button
            className="study-nav"
            onClick={() =>
              document.querySelector<HTMLTextAreaElement>("textarea")?.focus()
            }
          >
            ⌕ <span>Search</span>
            <kbd>⌘K</kbd>
          </button>
          <p className="study-sidebar-label">Projects</p>
          <div className="study-project">⌄　aurora</div>
          <button
            className="study-session is-selected"
            onClick={() => choose("completed")}
          >
            <span className="study-session-dot" />
            Bound the sync queue retries
          </button>
          <button className="study-session" onClick={() => choose("idle")}>
            Fix the editor file tree
          </button>
          <p className="study-sidebar-label">Recents</p>
          <span className="study-empty">No other chats</span>
          <div className="study-sidebar-footer">
            <img src="/gyro-logo.png" alt="Gyro" />
            <span>Your local workspace</span>
          </div>
        </aside>
        <main className="study-main">
          <header className="study-thread-header">
            <span>Bound the sync queue retries</span>
            <span className="study-secondary">
              aurora <span aria-hidden="true">/</span> main
            </span>
          </header>
          <div
            className="study-thread-body"
            ref={body}
            aria-label="Conversation"
            tabIndex={0}
          >
            {long && (
              <div className="study-history">
                {Array.from({ length: 120 }, (_, i) => (
                  <article key={i}>
                    <p className="study-old-prompt">
                      Check {i + 1}: keep the change small and show what passed.
                    </p>
                    <p>
                      The local change is ready to review. The focused check
                      passed.
                    </p>
                  </article>
                ))}
              </div>
            )}
            {state === "idle" ? (
              <div className="study-welcome">
                <img src="/gyro-logo.png" alt="Gyro" />
                <h1>What should we do in aurora?</h1>
                <p>Start with the thing you want to change.</p>
              </div>
            ) : (
              <article className="study-turn">
                <div className="study-user-message">
                  Bound the sync queue retries and cover the failure case with a
                  test.
                </div>
                <div className={`study-state state-${state}`} role="status">
                  <span className="study-state-mark" aria-hidden="true">
                    {state === "completed"
                      ? "✓"
                      : state === "stopped"
                        ? "■"
                        : state === "failed"
                          ? "!"
                          : state === "approval"
                            ? "◇"
                            : "◌"}
                  </span>
                  {labels[state]}
                </div>
                <ChatRun
                  model={model}
                  statusLabel={
                    state === "completed" ? "Completed · 18s" : labels[state]
                  }
                  suppressThinkingIndicator={
                    state === "preparing" || state === "approval"
                  }
                  onOpenChanges={() => {
                    setPanel("Review");
                    setPanelOpen(true);
                  }}
                  onRetry={start}
                />
                {state === "approval" && (
                  <section className="study-approval">
                    <strong>Run the focused tests?</strong>
                    <p>
                      <code>node --test src/sync.test.js</code>
                    </p>
                    <p>Checks the edited retry loop in aurora.</p>
                    <div>
                      <button
                        className="gyro-secondary-button"
                        onClick={() => choose("stopped")}
                      >
                        Reject
                      </button>
                      <button className="gyro-primary-button" onClick={start}>
                        Allow once
                      </button>
                    </div>
                  </section>
                )}
                {state === "preparing" && (
                  <p className="study-status-detail">
                    Checking the workspace before starting the provider.
                  </p>
                )}
                {(stream || state === "completed") && (
                  <div className="study-answer">
                    <p>{state === "completed" ? answer : stream}</p>
                    {state === "completed" && (
                      <p>
                        Both focused tests passed. The changes are ready to
                        review.
                      </p>
                    )}
                  </div>
                )}
                {state === "working" && (
                  <p className="study-status-detail">
                    Provider connected. Waiting for the next result.
                  </p>
                )}
                {state === "stopped" && (
                  <p className="study-status-detail">
                    Work stopped. Existing edits remain available to review.
                  </p>
                )}
                {state !== "preparing" && (
                  <button
                    className="study-result"
                    onClick={() => {
                      setPanel("Review");
                      setPanelOpen(true);
                    }}
                  >
                    <span>
                      1 file changed <small>src/sync.js</small>
                    </span>
                    <span>
                      <b className="study-added">+24</b>{" "}
                      <b className="study-removed">−6</b>　Review ›
                    </span>
                  </button>
                )}
              </article>
            )}
          </div>
          <div className="study-composer-dock">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!running) start();
              }}
            >
              <textarea
                aria-label="Message Gyro"
                placeholder={
                  state === "idle"
                    ? "Describe what you want to build…"
                    : "Ask a follow-up…"
                }
                value={input}
                onChange={(e) => {
                  marks.current.input = performance.now();
                  setInput(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !running) {
                    e.preventDefault();
                    start();
                  }
                }}
              />
              <div className="study-composer-tools">
                <span>＋</span>
                <span className="study-secondary">◈ Ask first</span>
                <span className="study-model">
                  Grok 4.6 <span className="study-secondary">Medium</span>
                </span>
                {running ? (
                  <button
                    type="button"
                    className="study-send"
                    aria-label="Stop generating"
                    onClick={(event) => {
                      event.preventDefault();
                      stop();
                    }}
                  >
                    ■
                  </button>
                ) : (
                  <button
                    className="study-send"
                    aria-label="Send message"
                    type="submit"
                  >
                    ↑
                  </button>
                )}
              </div>
            </form>
            <div className="study-composer-footer">
              <span>aurora　/　Project folder　/　main</span>
              <span>Sample workspace</span>
            </div>
          </div>
        </main>
        {panelOpen && (
          <div
            role="separator"
            aria-label="Resize companion panel"
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            aria-valuemin={240}
            aria-valuemax={600}
            tabIndex={0}
            className="study-divider"
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setPanelWidth((w) =>
                  Math.max(
                    240,
                    Math.min(600, w + (e.key === "ArrowLeft" ? 20 : -20)),
                  ),
                );
              }
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                setPanelWidth(
                  Math.max(
                    240,
                    Math.min(600, window.innerWidth - e.clientX - 48),
                  ),
                );
            }}
            onPointerUp={(e) =>
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          />
        )}
        {panelOpen && (
          <aside
            className="study-companion"
            style={{ width: panelWidth }}
            aria-label="Companion panel"
          >
            <header>
              <span>{panel}</span>
              <button
                aria-label="Close companion panel"
                onClick={() => setPanelOpen(false)}
              >
                ×
              </button>
            </header>
            {panel === "Review" &&
            (state === "idle" || state === "preparing") ? (
              <p className="study-review-note">
                No changes in this request yet.
              </p>
            ) : panel === "Review" ? (
              <>
                <div className="study-review-heading">
                  <strong>src/sync.js</strong>
                  <span>
                    <b className="study-added">+24</b>{" "}
                    <b className="study-removed">−6</b>
                  </span>
                </div>
                <p className="study-review-note">
                  Limit retries and preserve the final error.
                </p>
                <pre className="study-diff">
                  <span> async drain() {"\n"}</span>
                  <span className="study-diff-removed">
                    − while (true) {"\n"}
                  </span>
                  <span className="study-diff-added">
                    + for (let attempt = 0;{"\n"}+ attempt &lt; 5; attempt++){" "}
                    {"\n"}
                  </span>
                  <span>
                    {" "}
                    try {"\n"} await this.send(job);{"\n"} break;{"\n"} {"}"}{" "}
                    catch (error) {"\n"}
                  </span>
                  <span className="study-diff-added">
                    + if (attempt === 4) throw error;{"\n"}+ await
                    delay(backoff(attempt));{"\n"}
                  </span>
                  <span>
                    {" "}
                    {"}"}
                    {"\n"} {"}"}
                    {"\n"} {"}"}
                  </span>
                </pre>
                <div className="study-verification">
                  <span>
                    {state === "completed"
                      ? "✓ Focused checks passed"
                      : "Verification pending"}
                  </span>
                  <small>
                    {state === "completed"
                      ? "2 tests · sample result"
                      : "No passing result recorded yet"}
                  </small>
                </div>
              </>
            ) : panel === "Terminal" ? (
              <pre className="study-terminal">
                {state === "idle" || state === "preparing"
                  ? "No command running."
                  : "$ node --test src/sync.test.js\n\n"}
                {state === "completed"
                  ? "✔ caps retries at five attempts\n✔ surfaces the final error\n\n2 passed"
                  : state === "idle" || state === "preparing"
                    ? ""
                    : "Waiting for a result…"}
              </pre>
            ) : panel === "Files" ? (
              <div className="study-files">
                aurora
                <br />
                　src
                <br />
                　　sync.js
                <br />
                　　sync.test.js
                <br />
                　README.md
              </div>
            ) : (
              <div className="study-files">
                Browser preview
                <br />
                <p>No preview open in this sample.</p>
              </div>
            )}
          </aside>
        )}
        <nav className="study-tools" aria-label="Companion tools">
          {[
            ["Review", "◫"],
            ["Terminal", "⌘"],
            ["Files", "▤"],
            ["Browser", "◎"],
          ].map(([name, icon]) => (
            <button
              key={name}
              aria-label={name}
              title={name}
              aria-pressed={panelOpen && panel === name}
              onClick={() => {
                setPanel(name!);
                setPanelOpen(true);
              }}
            >
              {icon}
            </button>
          ))}
          <button
            aria-label="About this prototype"
            onClick={() => setDetails(!details)}
          >
            ⓘ
          </button>
        </nav>
      </div>
      {details && (
        <aside className="study-about">
          <strong>Gyro design study</strong>
          <p>
            Uses Gyro’s shared tokens and real work timeline component. Provider
            activity, diffs, and checks are simulated. No files or accounts are
            accessed.
          </p>
          <button onClick={() => setDetails(false)}>Close</button>
        </aside>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Prototype />);
