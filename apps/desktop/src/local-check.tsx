import type { CheckReminder } from "./check-reminder";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckWorkContext,
  CheckWorkActivityContext,
  type CheckWorkActivity,
  confirmAction,
  useDialogDismiss,
} from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";
import type {
  CheckDraft,
  CheckPlan,
  CheckReport,
  CheckScope,
  BrowserCheck,
} from "./local-check-types";
import "./local-check.css";

type CheckSession = { id: string; title: string; workspacePath: string };
type CheckInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
type CheckCloudRequest = (
  request: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const scopeLabels = {
  api: "API responses",
  browser: "Browser interaction",
  command: "Other command assertions",
  unspecified: "Not recorded",
};

function BrowserActionReview({ browser }: { browser: BrowserCheck }) {
  return (
    <>
      <p>
        Wait for one visible element matching{" "}
        <code>{browser.readySelector}</code>.
      </p>
      {browser.viewport ? (
        <p>
          Reviewed viewport: {browser.viewport.width} ×{" "}
          {browser.viewport.height} CSS pixels. Height reads measure one visible
          element’s bounding box in CSS pixels, without rounding.
        </p>
      ) : null}
      <ol>
        {browser.steps.map((step, index) => (
          <li key={index}>
            {step.action === "fill" ? (
              <>
                Fill <code>{step.selector}</code> with{" "}
                <code style={{ whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(step.text)}
                </code>
                .
              </>
            ) : step.action === "click" ? (
              <>
                Click <code>{step.selector}</code>.
              </>
            ) : (
              <>
                Observe <code>{step.criterionId}</code> for up to {step.waitMs}{" "}
                ms:{" "}
                {step.reads.map((read, i) => (
                  <span key={read.key}>
                    {i ? "; " : ""}
                    <code>{read.key}</code> ={" "}
                    {read.kind === "height"
                      ? "bounding-box height in CSS pixels"
                      : read.kind === "count"
                        ? "visible element count"
                        : read.kind === "texts"
                          ? "visible text list"
                          : "visible text"}{" "}
                    from <code>{read.selector}</code>
                  </span>
                ))}
                .
              </>
            )}
          </li>
        ))}
      </ol>
      <details>
        <summary>Inspect browser plan JSON</summary>
        <pre>{JSON.stringify(browser, null, 2)}</pre>
      </details>
    </>
  );
}

export function LocalCheckHost({
  sessions,
  reminders = [],
  onDismissReminder,
  children,
  call,
  available,
  cloudRequest,
  cloudUnavailableReason,
}: {
  sessions: CheckSession[];
  reminders?: CheckReminder[];
  onDismissReminder?: (turnId: string) => void;
  children: ReactNode;
  call?: CheckInvoke;
  available?: boolean;
  cloudRequest?: CheckCloudRequest;
  cloudUnavailableReason?: string;
}) {
  const [target, setTarget] = useState<string>();
  const [opened, setOpened] = useState<
    Record<string, { sourceTurnId?: string }>
  >({});
  const [activities, setActivities] = useState<
    Record<string, CheckWorkActivity>
  >({});
  const open = useCallback((id: string) => {
    setOpened((current) => (current[id] ? current : { ...current, [id]: {} }));
    setTarget(id);
  }, []);
  const hide = useCallback(() => setTarget(undefined), []);
  const activityChanged = useCallback(
    (id: string, activity?: CheckWorkActivity) => {
      setActivities((current) => {
        const next = { ...current };
        if (activity) next[id] = activity;
        else delete next[id];
        return next;
      });
    },
    [],
  );
  return (
    <CheckWorkContext.Provider value={open}>
      <CheckWorkActivityContext.Provider value={activities}>
        {children}
        {reminders.length ? (
          <aside
            className="gyro-check-reminder"
            aria-label="Finished work to check"
          >
            {reminders.map((reminder) => (
              <div key={reminder.turnId}>
                <span>
                  {sessions.find((s) => s.id === reminder.sessionId)?.title ??
                    "Finished chat"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setOpened((current) =>
                      current[reminder.sessionId]
                        ? current
                        : {
                            ...current,
                            [reminder.sessionId]: {
                              sourceTurnId: reminder.turnId,
                            },
                          },
                    );
                    setTarget(reminder.sessionId);
                    onDismissReminder?.(reminder.turnId);
                  }}
                >
                  Check this work
                </button>
                <button
                  type="button"
                  aria-label="Dismiss Check reminder"
                  onClick={() => onDismissReminder?.(reminder.turnId)}
                >
                  Dismiss
                </button>
              </div>
            ))}
          </aside>
        ) : null}
        {sessions
          .filter((session) => opened[session.id])
          .map((session) => (
            <LocalCheckDialog
              key={session.id}
              session={session}
              sourceTurnId={opened[session.id]?.sourceTurnId}
              visible={target === session.id}
              onClose={hide}
              onOpen={open}
              onActivity={activityChanged}
              call={call}
              available={available}
              cloudRequest={cloudRequest}
              cloudUnavailableReason={cloudUnavailableReason}
            />
          ))}
      </CheckWorkActivityContext.Provider>
    </CheckWorkContext.Provider>
  );
}

// Only the visible surface owns the focus trap. The check controller stays
// mounted when hidden, retaining the single in-flight approval and its result.
function CheckDialogSurface({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const { ref, dismiss } = useDialogDismiss(onClose);
  return (
    <div
      className="gyro-check-backdrop"
      ref={ref}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      {children}
    </div>
  );
}

export function LocalCheckDialog({
  session,
  sourceTurnId,
  onClose,
  visible = true,
  onOpen,
  onActivity,
  call = invoke,
  available = isTauriRuntime(),
  cloudRequest,
  cloudUnavailableReason,
}: {
  session: CheckSession;
  sourceTurnId?: string;
  onClose: () => void;
  visible?: boolean;
  onOpen?: (sessionId: string) => void;
  onActivity?: (sessionId: string, activity?: CheckWorkActivity) => void;
  call?: CheckInvoke;
  available?: boolean;
  cloudRequest?: CheckCloudRequest;
  cloudUnavailableReason?: string;
}) {
  const [requirements, setRequirements] = useState<
    { id: string; requirement: string; expected: string; scope: CheckScope }[]
  >(
    sourceTurnId
      ? []
      : [
          {
            id: "add-item",
            requirement: "Add a to-do item",
            expected: "true",
            scope: "api",
          },
          {
            id: "reject-empty",
            requirement: "Reject an empty title",
            expected: "true",
            scope: "api",
          },
        ],
  );
  const [previewUrl, setPreviewUrl] = useState("http://127.0.0.1:4317");
  const [command, setCommand] = useState("");
  const [actionKind, setActionKind] = useState("command");
  const [browserSteps, setBrowserSteps] = useState("[]");
  const [browserReadySelector, setBrowserReadySelector] = useState("form");
  const [browserWidth, setBrowserWidth] = useState("1280");
  const [browserHeight, setBrowserHeight] = useState("800");
  const [dataChanges, setDataChanges] = useState("");
  const [files, setFiles] = useState("");
  const [plan, setPlan] = useState<CheckPlan>();
  const [stage, setStage] = useState<"requirements" | "results">(
    "requirements",
  );
  const dialogRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    dialogRef.current?.scrollTo({ top: 0 });
  }, [plan?.id, visible, stage]);
  const [confirmed, setConfirmed] = useState(false);
  const [hasActivity, setHasActivity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [reports, setReports] = useState<CheckReport[]>([]);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const operation = useRef(false);
  const reportRevision = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!available) return;
    const revision = reportRevision.current;
    try {
      const saved = await call<CheckReport[]>("list_local_checks", {
        sessionId: session.id,
      });
      if (
        alive.current &&
        !operation.current &&
        revision === reportRevision.current
      )
        setReports(saved);
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  }, [available, call, session.id]);
  useEffect(() => {
    if (!visible && !hasActivity) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (!operation.current) void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh, visible, hasActivity]);

  const resolve = async (
    decision: "approve" | "deny" | "cancel",
    close = false,
  ) => {
    if (!plan || operation.current) return;
    operation.current = true;
    reportRevision.current += 1;
    setBusy(true);
    setError("");
    setRunning(decision === "approve");
    if (decision === "approve") setHasActivity(true);
    try {
      const report = await call<CheckReport>("resolve_local_check", {
        planId: plan.id,
        decision,
        testEnvironmentConfirmed: confirmed,
      });
      if (!alive.current) return;
      setReports((current) => [
        report,
        ...current.filter((r) => r.plan.id !== report.plan.id),
      ]);
      setPlan(undefined);
      setConfirmed(false);
      setStage(decision === "approve" ? "results" : "requirements");
      if (close) onClose();
    } catch (e) {
      if (alive.current) {
        setError(String(e));
        setPlan(undefined);
      }
    } finally {
      operation.current = false;
      if (alive.current) {
        setBusy(false);
        setRunning(false);
      }
    }
  };
  const close = () => {
    if (running) {
      onClose();
      return;
    }
    if (operation.current) return;
    if (plan) void resolve("cancel", true);
    else onClose();
  };
  const openDetails = useCallback(
    () => onOpen?.(session.id),
    [onOpen, session.id],
  );
  const dismissActivity = useCallback(() => setHasActivity(false), []);
  const stop = useCallback(() => {
    if (!running || !plan) return;
    void call("cancel_local_check", { planId: plan.id }).catch((e) =>
      setError(String(e)),
    );
  }, [running, plan, call]);
  const latest = reports[0];
  const resultSummary = latest
    ? [
        ["passed", "passed"],
        ["failed", "failed"],
        ["not-checked", "not checked"],
      ]
        .flatMap(([status, label]) => {
          const count = latest.results.filter(
            (result) => result.status === status,
          ).length;
          return count ? [`${count} ${label}`] : [];
        })
        .join(" · ")
    : "No result recorded";
  const activityLabel = running
    ? "Running"
    : error
      ? "Needs attention"
      : latest?.stale
        ? "Out of date"
        : latest?.output?.termination.kind === "cancelled"
          ? "Stopped"
          : "Finished";
  const activityDetail =
    error || (running ? `Checking ${session.title}` : resultSummary);
  useEffect(() => {
    onActivity?.(
      session.id,
      hasActivity
        ? {
            running,
            label: activityLabel,
            detail: activityDetail,
            open: openDetails,
            stop,
            dismiss: dismissActivity,
          }
        : undefined,
    );
  }, [
    onActivity,
    session.id,
    hasActivity,
    running,
    activityLabel,
    activityDetail,
    openDetails,
    stop,
    dismissActivity,
  ]);
  useEffect(
    () => () => onActivity?.(session.id, undefined),
    [onActivity, session.id],
  );

  const prepare = async () => {
    if (operation.current || !available) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      const draft: CheckDraft = {
        sessionId: session.id,
        previewUrl,
        command: actionKind === "browser" ? "" : command,
        ...(actionKind === "browser"
          ? {
              browser: {
                readySelector: browserReadySelector,
                viewport: {
                  width: Number(browserWidth),
                  height: Number(browserHeight),
                },
                steps: JSON.parse(browserSteps),
              },
            }
          : {}),
        dataChanges,
        files: files
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        criteria: requirements
          .filter((r) => r.requirement.trim())
          .map((r) => ({ ...r, expected: JSON.parse(r.expected) as unknown })),
      };
      const reviewed = await call<CheckPlan>("prepare_local_check", { draft });
      if (alive.current) {
        setPlan(reviewed);
        setConfirmed(false);
      }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const loadExample = (variant: string) => {
    setActionKind("command");
    setCommand(`node scripts/fixtures/gyro-check/check.mjs ${variant}`);
    setDataChanges(
      "Start and stop an isolated loopback to-do server. Create synthetic in-memory items; no project files are written. Fail if the port is already occupied.",
    );
    setFiles(
      ["todo.mjs", "server.mjs", "check.mjs", "index.html"]
        .map((f) => `scripts/fixtures/gyro-check/${f}`)
        .join("\n"),
    );
    setRequirements([
      {
        id: "add-item",
        requirement:
          variant === "broken-form"
            ? "Add a to-do item using the browser form"
            : "Add a to-do item",
        expected: "true",
        scope: variant === "broken-form" ? "browser" : "api",
      },
      {
        id: "reject-empty",
        requirement: "Reject an empty title",
        expected: "true",
        scope: "api",
      },
    ]);
  };

  const loadBrowserExample = () => {
    setActionKind("browser");
    setBrowserReadySelector("form");
    setBrowserSteps(
      JSON.stringify(
        [
          {
            action: "fill",
            selector: 'input[aria-label="To-do title"]',
            text: "Gyro Check item",
          },
          { action: "click", selector: "form button" },
          {
            action: "observe",
            criterionId: "add-item",
            reads: [
              {
                key: "texts",
                selector: "ul li",
                kind: "texts",
              },
              { key: "items", selector: "ul li", kind: "count" },
            ],
            waitMs: 1500,
          },
          {
            action: "fill",
            selector: 'input[aria-label="To-do title"]',
            text: "   ",
          },
          { action: "click", selector: "form button" },
          {
            action: "observe",
            criterionId: "reject-empty",
            reads: [
              { key: "error", selector: "#error", kind: "text" },
              { key: "items", selector: "ul li", kind: "count" },
            ],
            waitMs: 1500,
          },
        ],
        null,
        2,
      ),
    );
    setDataChanges(
      "Requires a freshly started synthetic to-do fixture. Open a separate temporary native browser; fill/click the reviewed selectors once and read visible text/counts. Add one in-memory item and submit one blank title. Close that browser afterward. No command runs. Restart the fixture between checks.",
    );
    setFiles(
      ["todo.mjs", "server.mjs", "index.html"]
        .map((f) => `scripts/fixtures/gyro-check/${f}`)
        .join("\n"),
    );
    setRequirements([
      {
        id: "add-item",
        requirement: "Add a to-do item using the browser form",
        scope: "browser",
        expected: JSON.stringify({ texts: ["Gyro Check item"], items: 1 }),
      },
      {
        id: "reject-empty",
        requirement: "Show the empty-title error without adding another item",
        scope: "browser",
        expected: JSON.stringify({ error: "A title is required", items: 1 }),
      },
    ]);
  };

  const remove = async (id: string) => {
    if (
      operation.current ||
      !(await confirmAction(
        "Delete this local Check report and its saved output?",
      ))
    )
      return;
    operation.current = true;
    reportRevision.current += 1;
    setBusy(true);
    try {
      await call("delete_local_check", { sessionId: session.id, reportId: id });
      setReports((current) => current.filter((r) => r.plan.id !== id));
    } catch (e) {
      setError(String(e));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  if (!visible) return null;
  return (
    <CheckDialogSurface onClose={close}>
      <section
        className="gyro-check-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gyro-check-title"
      >
        <header>
          <div>
            <h2 id="gyro-check-title">Check this work</h2>
            <p>{session.title}</p>
            {sourceTurnId ? (
              <p>
                Finished turn <code>{sourceTurnId}</code>. Add your check
                criteria before preparing a plan.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            disabled={busy && !running}
            aria-label="Close Check"
          >
            Close
          </button>
        </header>
        <ol className="gyro-check-steps" aria-label="Check progress">
          {["Requirements", "Review", "Results"].map((label, index) => {
            const current = plan ? 1 : stage === "results" ? 2 : 0;
            return (
              <li
                key={label}
                aria-current={index === current ? "step" : undefined}
                data-complete={index < current}
              >
                <span>{index + 1}</span>
                {label}
              </li>
            );
          })}
        </ol>
        {!available ? (
          <p role="status">
            Run this flow in the desktop app. This browser preview cannot
            execute local checks.
          </p>
        ) : null}
        {error ? (
          <p className="gyro-check-error" role="alert">
            {error}
          </p>
        ) : null}
        {!plan && stage === "requirements" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void prepare();
            }}
          >
            <fieldset disabled={busy || !available}>
              <legend>Requirements</legend>
              {requirements.map((criterion, index) => (
                <div className="gyro-check-criterion" key={criterion.id}>
                  <label>
                    Requirement {index + 1}
                    <input
                      value={criterion.requirement}
                      onChange={(e) =>
                        setRequirements((current) =>
                          current.map((r, i) =>
                            i === index
                              ? { ...r, requirement: e.target.value }
                              : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Evidence needed for requirement {index + 1}
                    <select
                      value={criterion.scope}
                      onChange={(e) =>
                        setRequirements((current) =>
                          current.map((r, i) =>
                            i === index
                              ? { ...r, scope: e.target.value as CheckScope }
                              : r,
                          ),
                        )
                      }
                    >
                      <option value="api">API responses</option>
                      <option value="browser">Browser interaction</option>
                      <option value="command">Other command assertions</option>
                    </select>
                  </label>
                  <label>
                    Expected observation · <code>{criterion.id}</code>
                    <input
                      value={criterion.expected}
                      onChange={(e) =>
                        setRequirements((current) =>
                          current.map((r, i) =>
                            i === index
                              ? { ...r, expected: e.target.value }
                              : r,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
              ))}
              <label>
                Local test URL
                <input
                  type="url"
                  required
                  value={previewUrl}
                  onChange={(e) => setPreviewUrl(e.target.value)}
                />
              </label>
              <label>
                Check action
                <select
                  value={actionKind}
                  onChange={(e) => setActionKind(e.target.value)}
                >
                  <option value="command">Test command</option>
                  <option value="browser">Native browser steps</option>
                </select>
              </label>
              {actionKind === "command" ? (
                <label>
                  Test command
                  <textarea
                    required
                    rows={2}
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="Your reviewed test command"
                    spellCheck={false}
                  />
                </label>
              ) : (
                <>
                  <label>
                    Expected page · ready selector
                    <input
                      required
                      value={browserReadySelector}
                      onChange={(e) => setBrowserReadySelector(e.target.value)}
                    />
                  </label>
                  <label>
                    Browser steps · JSON
                    <textarea
                      required
                      rows={10}
                      value={browserSteps}
                      onChange={(e) => setBrowserSteps(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    Viewport width · CSS pixels
                    <input
                      type="number"
                      min={320}
                      max={2560}
                      step={1}
                      required
                      value={browserWidth}
                      onChange={(e) => setBrowserWidth(e.target.value)}
                    />
                  </label>
                  <label>
                    Viewport height · CSS pixels
                    <input
                      type="number"
                      min={320}
                      max={1600}
                      step={1}
                      required
                      value={browserHeight}
                      onChange={(e) => setBrowserHeight(e.target.value)}
                    />
                  </label>
                </>
              )}
              <label>
                Expected data changes
                <textarea
                  required
                  rows={2}
                  value={dataChanges}
                  onChange={(e) => setDataChanges(e.target.value)}
                />
              </label>
              <label>
                Files covered by the result · one relative path per line
                <textarea
                  required
                  rows={4}
                  value={files}
                  onChange={(e) => setFiles(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <p>
                Only these files and Git HEAD are fingerprinted. Add your app
                code and test runner. Runtime data and other files are outside
                this snapshot.
              </p>
              <details>
                <summary>Test command output format</summary>
                <p>
                  The command must exit successfully and return this JSON on
                  stdout. Expected observations are JSON values; each is
                  compared exactly with <code>actual</code>. The command
                  receives the test URL as <code>GYRO_CHECK_URL</code>. Output
                  is saved locally; use synthetic data without secrets.
                </p>
                <pre>
                  {JSON.stringify(
                    {
                      version: 2,
                      previewUrl,
                      observations: [
                        {
                          criterionId: "add-item",
                          scope: requirements[0]?.scope ?? "api",
                          actual: true,
                          evidence: "The actual response or assertion output",
                        },
                      ],
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <details>
                <summary>
                  Controlled to-do example · in the Gyro repository
                </summary>
                <p>
                  Working: both pass. Broken: empty titles are accepted. Broken
                  form: the API works but the Add button does not add an item.
                  Unavailable: the server cannot be reached. These are
                  command/API fixture checks; no visual behavior is checked.
                </p>
                <div className="gyro-check-actions">
                  {["working", "broken", "broken-form", "unavailable"].map(
                    (variant) => (
                      <button
                        type="button"
                        key={variant}
                        onClick={() => loadExample(variant)}
                      >
                        Load {variant}
                      </button>
                    ),
                  )}
                </div>
                <p>
                  For a browser form check, first start a fresh fixture with
                  <code>
                    {" "}
                    node scripts/fixtures/gyro-check/server.mjs working
                  </code>
                  (or <code>broken</code> / <code>broken-form</code>). Restart
                  it between checks. The browser action never starts a server.
                </p>
                <button type="button" onClick={loadBrowserExample}>
                  Load browser form check
                </button>
              </details>
              <button type="submit" className="gyro-check-primary">
                {busy ? "Preparing…" : "Review check plan"}
              </button>
            </fieldset>
          </form>
        ) : plan ? (
          <section
            aria-label="Review exact check action"
            className="gyro-check-review"
          >
            {running ? (
              <p className="gyro-check-running" role="status">
                Checking… You can close this window and keep working.
              </p>
            ) : null}
            <h3>Requirements</h3>
            <div className="gyro-check-reviewed-requirements">
              {plan.draft.criteria.map((criterion, index) => (
                <details key={criterion.id}>
                  <summary>
                    <span className="gyro-check-number">{index + 1}</span>
                    <span>
                      {criterion.requirement}
                      <small>{scopeLabels[criterion.scope]}</small>
                    </span>
                  </summary>
                  <p>
                    Expected <code>{criterion.id}</code> to equal{" "}
                    <code>{JSON.stringify(criterion.expected)}</code>.
                  </p>
                </details>
              ))}
            </div>
            <h3>Check details</h3>
            <dl>
              <dt>Working directory</dt>
              <dd>{plan.snapshot.workspace}</dd>
              <dt>Local URL</dt>
              <dd>{plan.draft.previewUrl}</dd>
              <dt>Expected data changes</dt>
              <dd>{plan.draft.dataChanges}</dd>
              <dt>Covered files</dt>
              <dd>
                {plan.snapshot.files.map((file) => (
                  <div key={file.path}>{file.path}</div>
                ))}
              </dd>
            </dl>
            <details className="gyro-check-action-details">
              <summary>
                View exact {plan.draft.browser ? "browser steps" : "command"}{" "}
                and expectations
              </summary>
              {plan.draft.browser ? (
                <BrowserActionReview browser={plan.draft.browser} />
              ) : (
                <pre>{plan.draft.command}</pre>
              )}
              <details>
                <summary>Approved file snapshot</summary>
                <pre>
                  {plan.snapshot.gitHead ?? "No Git HEAD available"}
                  {"\n"}
                  {plan.snapshot.files
                    .map((file) => `${file.path}  ${file.sha256}`)
                    .join("\n")}
                </pre>
              </details>
              <details className="gyro-check-execution-details">
                <summary>Execution scope and limits</summary>
                {plan.draft.browser ? (
                  <p>
                    Uses a separate temporary native browser, with navigation
                    limited to the reviewed origin. Downloads and new windows
                    are denied. Only reviewed fill/click actions and visible
                    text/count/height reads run; no command executes. The page
                    may make its own network requests. The browser closes
                    afterward. Page readiness has a 10-second deadline, then
                    steps have a 60-second deadline checked between bounded
                    calls; a call in progress may finish later.
                  </p>
                ) : (
                  <p>
                    Runs for at most 60 seconds with Gyro’s workspace filesystem
                    policy and credential scrubbing. Network access is allowed.
                    A local URL can still change real data.
                  </p>
                )}
              </details>
            </details>
          </section>
        ) : null}
        {!plan && stage === "results" ? (
          <div className="gyro-check-result-heading">
            <div>
              <h3>Check results</h3>
              <p>{resultSummary}</p>
            </div>
            <button type="button" onClick={() => setStage("requirements")}>
              New check
            </button>
          </div>
        ) : null}
        <details
          open={stage === "results" && !plan}
          className="gyro-check-history"
        >
          <summary>
            {stage === "results" && !plan
              ? "Local reports"
              : `Previous checks (${reports.length})`}
          </summary>
          <section
            aria-label="Saved Check reports"
            className="gyro-check-reports"
          >
            <h3>Local reports</h3>
            {!reports.length ? (
              <p>No saved checks for this chat.</p>
            ) : (
              reports.map((report) => (
                <CheckReportView
                  key={report.plan.id}
                  report={report}
                  disabled={busy}
                  onDelete={() => void remove(report.plan.id)}
                  cloudRequest={cloudRequest}
                  cloudUnavailableReason={cloudUnavailableReason}
                  sharePrimary={
                    stage === "results" &&
                    !plan &&
                    report.plan.id === latest?.plan.id
                  }
                />
              ))
            )}
          </section>
        </details>
        {plan ? (
          <>
            <div className="gyro-check-footer">
              {!running ? (
                <label className="gyro-check-consent">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I approve this test environment, action and expected data
                  changes.
                </label>
              ) : null}
              <div className="gyro-check-actions">
                {!running ? (
                  <>
                    <button
                      type="button"
                      className="gyro-check-primary"
                      disabled={busy || !confirmed}
                      onClick={() => void resolve("approve")}
                    >
                      {running ? "Checking…" : "Approve and run"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resolve("deny")}
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resolve("cancel")}
                    >
                      Cancel check
                    </button>
                  </>
                ) : null}
                {running ? (
                  <>
                    <button type="button" onClick={onClose}>
                      Close and keep running
                    </button>
                    <button type="button" onClick={stop}>
                      Stop running check
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </section>
    </CheckDialogSurface>
  );
}

function CheckReportView({
  report,
  onDelete,
  disabled,
  cloudRequest,
  cloudUnavailableReason,
  sharePrimary,
}: {
  report: CheckReport;
  onDelete: () => void;
  disabled: boolean;
  cloudRequest?: CheckCloudRequest;
  cloudUnavailableReason?: string;
  sharePrimary?: boolean;
}) {
  return (
    <article className="gyro-check-report">
      <header>
        <div>
          <time dateTime={report.finishedAt}>
            {new Date(report.finishedAt).toLocaleString()}
          </time>
          {report.stale ? (
            <strong className="gyro-check-stale">Potentially stale</strong>
          ) : null}
        </div>
        <button type="button" disabled={disabled} onClick={onDelete}>
          Delete report
        </button>
      </header>
      <p>{report.freshnessNote}</p>
      {report.results.map((result) => {
        const criterion = report.plan.draft.criteria.find(
          (c) => c.id === result.criterionId,
        );
        return (
          <section
            key={result.criterionId}
            className={`gyro-check-result is-${result.status}`}
          >
            <h4>
              {result.status === "not-checked"
                ? "Not checked"
                : result.status === "passed"
                  ? "Passed"
                  : "Failed"}{" "}
              · {criterion?.requirement}
            </h4>
            <p>
              Required evidence:{" "}
              {scopeLabels[criterion?.scope ?? "unspecified"]}
              {result.observedScope
                ? ` · Returned: ${scopeLabels[result.observedScope]}`
                : ""}
            </p>
            <p>{result.reason}</p>
            {result.evidence ? (
              <>
                <p>
                  Expected <code>{JSON.stringify(criterion?.expected)}</code> ·
                  Observed <code>{JSON.stringify(result.actual)}</code>
                </p>
                <pre>{result.evidence}</pre>
              </>
            ) : null}
          </section>
        );
      })}
      <details>
        <summary>Inspect action, identity and raw output</summary>
        <dl>
          <dt>Chat</dt>
          <dd>{report.plan.draft.sessionId}</dd>
          <dt>Workspace</dt>
          <dd>{report.plan.snapshot.workspace}</dd>
          <dt>Git HEAD</dt>
          <dd>{report.plan.snapshot.gitHead ?? "Unavailable"}</dd>
          <dt>Prepared at</dt>
          <dd>{report.plan.createdAt}</dd>
          <dt>URL</dt>
          <dd>{report.plan.draft.previewUrl}</dd>
          <dt>{report.plan.draft.browser ? "Browser steps" : "Command"}</dt>
          <dd>
            <pre>
              {report.plan.draft.browser
                ? JSON.stringify(report.plan.draft.browser, null, 2)
                : report.plan.draft.command}
            </pre>
          </dd>
          <dt>Data changes</dt>
          <dd>{report.plan.draft.dataChanges}</dd>
        </dl>
        <pre>
          {report.plan.snapshot.files
            .map((f) => `${f.path}  ${f.sha256}`)
            .join("\n")}
        </pre>
        {report.output ? (
          <>
            <p>
              {report.plan.draft.browser
                ? `Browser driver: ${report.output.termination.kind === "exited" ? "finished" : report.output.termination.kind}`
                : `Termination: ${JSON.stringify(report.output.termination)}`}{" "}
              · {report.output.durationMs} ms
            </p>
            <h4>
              {report.plan.draft.browser
                ? "Recorded browser observations"
                : "stdout"}
            </h4>
            <pre>{report.output.stdout || "(empty)"}</pre>
            <h4>
              {report.plan.draft.browser ? "Browser diagnostics" : "stderr"}
            </h4>
            <pre>{report.output.stderr || "(empty)"}</pre>
          </>
        ) : (
          <p>No check output was recorded.</p>
        )}
      </details>
      <p>{report.omission}</p>
      <CheckReportShare
        report={report}
        disabled={disabled}
        request={cloudRequest}
        unavailableReason={cloudUnavailableReason}
        primary={sharePrimary}
      />
    </article>
  );
}

function CheckReportShare({
  report,
  disabled,
  request,
  unavailableReason,
  primary,
}: {
  report: CheckReport;
  disabled: boolean;
  request?: CheckCloudRequest;
  unavailableReason?: string;
  primary?: boolean;
}) {
  const [preview, setPreview] = useState<{ ticket: string; content: string }>();
  const [uploaded, setUploaded] = useState<{
    objectId: string;
    revisionId: string;
  }>();
  const [queued, setQueued] = useState<string>();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState<{
    id: string;
    url: string;
    expiresAt?: string;
  }>();
  const [copied, setCopied] = useState(false);
  const [shareUncertain, setShareUncertain] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!request) {
      setPreview(undefined);
      setUploaded(undefined);
      setQueued(undefined);
      setLink(undefined);
      setReviewed(false);
    }
  }, [request]);
  const run = async (action: () => Promise<void>) => {
    if (!request || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const start = () =>
    void run(async () => {
      const value = await request!({
        operation: "preview-report",
        localId: report.plan.draft.sessionId,
        reportId: report.plan.id,
      });
      if (
        typeof value.ticket !== "string" ||
        value.kind !== "report" ||
        typeof value.content !== "string" ||
        new TextEncoder().encode(value.content).length > 256 * 1024
      )
        throw new Error("The report preview could not be verified.");
      if (alive.current) {
        setPreview({ ticket: value.ticket, content: value.content });
        setReviewed(false);
        setUploaded(undefined);
        setQueued(undefined);
        setLink(undefined);
        setCopied(false);
        setShareUncertain(false);
      }
    });
  const create = () =>
    void run(async () => {
      if (!preview || !reviewed) return;
      let ack = uploaded;
      if (!ack) {
        const value = queued
          ? await request!({
              operation: "service",
              command: { operation: "retry-uploads" },
            })
          : await request!({
              operation: "upload-preview",
              ticket: preview.ticket,
              reviewed: true,
            });
        const candidate =
          queued && Array.isArray(value.completed)
            ? value.completed.find(
                (item: unknown) =>
                  !!item &&
                  typeof item === "object" &&
                  (item as Record<string, unknown>).requestId === queued,
              )
            : value.uploaded;
        if (
          !candidate ||
          typeof candidate !== "object" ||
          typeof (candidate as Record<string, unknown>).objectId !== "string" ||
          typeof (candidate as Record<string, unknown>).revisionId !== "string"
        ) {
          if (typeof value.requestId === "string" && alive.current)
            setQueued(value.requestId);
          throw new Error(
            "No report link was created. The reviewed upload is waiting for Cloud. Retry the upload when Cloud is available.",
          );
        }
        ack = candidate as { objectId: string; revisionId: string };
        if (alive.current) {
          setUploaded(ack);
          setQueued(undefined);
        }
      }
      // Share creation has no server idempotency key. Never offer a blind replay
      // after a transport failure or unverifiable acknowledgment.
      if (alive.current) setShareUncertain(true);
      try {
        const value = await request!({
          operation: "service",
          command: {
            operation: "create-share",
            objectId: ack.objectId,
            revisionId: ack.revisionId,
            expiresInDays: 7,
          },
        });
        if (typeof value.shareId !== "string" || typeof value.url !== "string")
          throw new Error("Unverified report link response.");
        if (alive.current) {
          setLink({
            id: value.shareId,
            url: value.url,
            expiresAt:
              typeof value.expiresAt === "string" ? value.expiresAt : undefined,
          });
          setPreview(undefined);
          setShareUncertain(false);
        }
      } catch {
        throw new Error(
          "Report link creation could not be confirmed. Check shared links in Cloud settings before reviewing again. This request will not retry automatically.",
        );
      }
    });
  return (
    <section className="gyro-check-share" aria-label="Share Check report">
      {!preview && !link ? (
        <>
          <button
            type="button"
            disabled={disabled || busy || !request}
            onClick={start}
          >
            {busy ? "Preparing report…" : "Share report"}
          </button>
          <p>
            {request
              ? `${unavailableReason?.includes("cached while offline") ? `${unavailableReason} ` : ""}Review a sanitized, read-only copy before sending it to Gyro Cloud.`
              : (unavailableReason ??
                "Report sharing needs a configured Gyro Cloud connection. Your local Check report remains available.")}
          </p>
        </>
      ) : null}
      {preview ? (
        <>
          <h4>Review report to share</h4>
          <p>
            This exact text will be sent to Gyro Cloud. Commands, raw output,
            file lists and local identities are excluded. Recognizable
            credentials block sharing; check the remaining text for sensitive
            information.
          </p>
          <pre tabIndex={0} aria-label="Exact report text to upload">
            {preview.content}
          </pre>
          <p>
            Anyone with the link can read this copy for 7 days. Revoke the link
            in Cloud settings. Deleting the local report does not revoke a
            shared copy.
          </p>
          <label className="gyro-check-consent">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={busy || !!uploaded || !!queued}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            I reviewed this text and want to upload it and create a public
            report link.
          </label>
          <div className="gyro-check-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPreview(undefined);
                setReviewed(false);
                setUploaded(undefined);
                setQueued(undefined);
                setError("");
              }}
            >
              Close review
            </button>
            <button
              type="button"
              className={primary ? "gyro-check-primary" : undefined}
              disabled={busy || !reviewed || !request || shareUncertain}
              onClick={create}
            >
              {busy
                ? "Creating report link…"
                : queued
                  ? "Retry report upload"
                  : uploaded
                    ? "Create report link"
                    : "Upload and create 7-day link"}
            </button>
          </div>
        </>
      ) : null}
      {link ? (
        <>
          <p role="status">
            Report link created
            {link.expiresAt
              ? ` · Expires ${new Date(link.expiresAt).toLocaleString()}`
              : " · Expires in 7 days"}
            .
          </p>
          <label>
            Report link
            <input
              readOnly
              value={link.url}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="gyro-check-actions">
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(link.url)
                  .then(() => setCopied(true))
                  .catch(() =>
                    setError(
                      "Copy failed. Select the report link and copy it manually.",
                    ),
                  )
              }
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              disabled={busy || !request}
              onClick={() =>
                void run(async () => {
                  await request!({
                    operation: "service",
                    command: { operation: "revoke-share", shareId: link.id },
                  });
                  if (alive.current) {
                    setLink(undefined);
                    setError(
                      "Report link revoked. The uploaded copy remains in Cloud until you delete it.",
                    );
                  }
                })
              }
            >
              Revoke link
            </button>
          </div>
        </>
      ) : null}
      {error ? (
        <p className="gyro-check-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
