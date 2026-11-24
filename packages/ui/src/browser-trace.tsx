import { useEffect, useRef, useState } from "react";
import {
  ComposerReviewerPicker,
  type ReviewerOption,
} from "./composer-reviewer-picker";
import type { ComposerReviewer } from "./composer-inline-draft";
import { ProviderLogo } from "./workspace-sidebar";
import "./browser-trace.css";

type Model = Pick<ComposerReviewer, "providerId" | "modelId">;
type Location = { path: string; line: number };
type Excerpt = {
  id: number;
  path: string;
  firstLine: number;
  selectedLine: number;
  lines: string[];
  hash: string;
};
type RuntimeEvent = { id: number; elapsedMs: number } & (
  | {
      kind: "request";
      method: string;
      origin: string;
      path: string;
      status: number | null;
    }
  | { kind: "console"; message: string; path?: string; line?: number }
);
type Evidence = { click: string | null; events: RuntimeEvent[] };
type Capture = {
  done: boolean;
  evidence: Evidence;
  partial?: string;
  analyzing?: boolean;
  browserModel?: Model;
  sourceModel?: Model;
  origin?: string;
  revision?: string;
};
export type BrowserTraceSetup = {
  question: string;
  origin: string;
  apiOrigin?: string;
  rootId: string;
  revision?: string;
  browserModel: Model;
  sourceModel: Model;
};
type Review = {
  id: string;
  browserInput: { question: string; evidence: Evidence };
  sourceInput: {
    question: string;
    evidence: Evidence;
    source: Omit<Excerpt, "hash" | "selectedLine">[];
  };
  excerpts: Excerpt[];
};
type Finding = {
  text: string;
  eventId: number;
  excerptId?: number;
  line?: number;
};
type Report = {
  id: string;
  setup: BrowserTraceSetup;
  evidence: Evidence;
  approvedEvidence: Evidence;
  excerpts: Excerpt[];
  browserFindings: Finding[];
  sourceFindings: Finding[];
  errors: string[];
  partial?: string;
};
export type BrowserTraceRuntime = {
  sessionId: string;
  roots: { id: string; path: string }[];
  activeRootId?: string;
  start(setup: BrowserTraceSetup): Promise<string>;
  active(): Promise<string | null>;
  status(id: string): Promise<Capture>;
  discard(id: string): Promise<void>;
  review(
    id: string,
    eventIds: number[],
    locations?: Location[],
  ): Promise<Review>;
  analyze(id: string, reviewId: string): Promise<Report>;
  history(): Promise<Report[]>;
  openSource(id: string, excerpt: number, line: number): Promise<boolean>;
};

const emptyEvidence: Evidence = { click: null, events: [] };
const matchModel = (left: Model | undefined, right: Model | undefined) =>
  !!left &&
  !!right &&
  left.providerId === right.providerId &&
  left.modelId === right.modelId;

export function traceQuestion(
  draft: string,
  commands: { start: number; end: number }[],
  original = draft,
) {
  const token = commands.find(
    ({ start, end }) => draft.slice(start, end) === "/trace",
  );
  if (token) return original.trim();
  const prefix = original.match(/^\s*\/trace(?=\s|$)/);
  return prefix ? original.slice(prefix[0].length).trim() : undefined;
}

function describeEvent(event: RuntimeEvent) {
  return event.kind === "request"
    ? `${event.method} ${event.path} · ${event.status ?? "No HTTP response"}`
    : event.message;
}

export function useBrowserTrace(
  runtime: BrowserTraceRuntime | undefined,
  openTrace: () => void,
) {
  const [active, setActive] = useState<{
    session: string;
    id: string;
    initiatedHere?: boolean;
  }>();
  const [capture, setCapture] = useState<Capture>();
  const runtimeRef = useRef(runtime);
  const openTraceRef = useRef(openTrace);
  runtimeRef.current = runtime;
  openTraceRef.current = openTrace;
  useEffect(() => {
    const owner = runtimeRef.current;
    if (!owner) return;
    let disposed = false;
    void owner
      .active()
      .then((id) => {
        if (id && !disposed)
          setActive((current) =>
            current?.session === owner.sessionId
              ? current
              : { session: owner.sessionId, id },
          );
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [runtime?.sessionId]);
  useEffect(() => {
    if (!active || runtimeRef.current?.sessionId !== active.session) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await runtimeRef.current!.status(active.id);
        if (disposed) return;
        setCapture(next);
        if (next.done && !next.analyzing) {
          if (active.initiatedHere) openTraceRef.current();
        } else timer = setTimeout(poll, 450);
      } catch (error) {
        if (disposed) return;
        setCapture({
          done: true,
          evidence: emptyEvidence,
          partial: String(error),
        });
        openTraceRef.current();
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, runtime?.sessionId]);
  return {
    id:
      runtime && active?.session === runtime.sessionId ? active.id : undefined,
    capture:
      runtime && active?.session === runtime.sessionId ? capture : undefined,
    begin: (id: string) => {
      if (runtime) {
        setCapture(undefined);
        setActive({ session: runtime.sessionId, id, initiatedHere: true });
      }
    },
    clear: () => {
      setActive(undefined);
      setCapture(undefined);
    },
  };
}

export function BrowserTracePanel({
  runtime,
  options,
  browserUrl,
  initialQuestion,
  run,
  openBrowser,
  draftFix,
}: {
  runtime: BrowserTraceRuntime;
  options: ReviewerOption[];
  browserUrl?: string;
  initialQuestion: string;
  run: ReturnType<typeof useBrowserTrace>;
  openBrowser: () => void;
  draftFix: (text: string) => void;
}) {
  const [question, setQuestion] = useState(initialQuestion);
  const [target, setTarget] = useState<string>();
  const [apiOrigin, setApiOrigin] = useState("");
  const [revision, setRevision] = useState("");
  const [rootId, setRootId] = useState(
    runtime.activeRootId ?? runtime.roots[0]?.id ?? "",
  );
  const [browserModel, setBrowserModel] = useState<ComposerReviewer>();
  const [sourceModel, setSourceModel] = useState<ComposerReviewer>();
  const [picker, setPicker] = useState<"browser" | "source">();
  const [reports, setReports] = useState<Report[]>([]);
  const [report, setReport] = useState<Report>();
  const [review, setReview] = useState<Review>();
  const [excluded, setExcluded] = useState<number[]>([]);
  const [locations, setLocations] = useState<Location[]>();
  const [path, setPath] = useState("");
  const [line, setLine] = useState("1");
  const [snippet, setSnippet] = useState<Excerpt>();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const operation = useRef(false);
  const browserOrigin = (() => {
    try {
      const url = new URL(browserUrl ?? "");
      return url.origin === "null" ? "" : url.origin;
    } catch {
      return "";
    }
  })();
  const selectedOrigin = target ?? browserOrigin;

  useEffect(() => {
    setQuestion(initialQuestion);
    setReport(undefined);
  }, [initialQuestion]);
  useEffect(() => {
    let disposed = false;
    runtime
      .history()
      .then((history) => {
        if (!disposed) setReports(history);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [runtime.sessionId]);

  async function action(label: string, work: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setPending(label);
    setError("");
    try {
      await work();
    } catch (error) {
      setError(String(error));
    } finally {
      operation.current = false;
      setPending("");
    }
  }

  const capture = run.capture;
  const canStart =
    question.trim() &&
    selectedOrigin &&
    selectedOrigin === browserOrigin &&
    rootId &&
    browserModel &&
    sourceModel &&
    !matchModel(browserModel, sourceModel);
  const modelLabel = (model: Model) =>
    options.find((option) => matchModel(model, option))?.label ?? model.modelId;
  const modelButton = (
    role: "browser" | "source",
    value?: ComposerReviewer,
  ) => (
    <button
      type="button"
      className="gyro-review-secondary"
      aria-expanded={picker === role}
      onClick={() => setPicker(picker === role ? undefined : role)}
    >
      {value ? (
        <>
          <ProviderLogo providerId={value.providerId} />
          {value.label}
        </>
      ) : (
        `Choose ${role} model`
      )}
    </button>
  );
  const eventList = (evidence: Evidence, choose = false) => (
    <>
      {evidence.click && (
        <p>
          <strong>Click</strong> · {evidence.click}
        </p>
      )}
      {evidence.events.length ? (
        <ul>
          {evidence.events.map((event) => (
            <li key={event.id}>
              {choose ? (
                <label>
                  <input
                    type="checkbox"
                    checked={!excluded.includes(event.id)}
                    disabled={!!pending}
                    onChange={(change) => {
                      setReview(undefined);
                      setExcluded((current) =>
                        change.target.checked
                          ? current.filter((id) => id !== event.id)
                          : [...current, event.id],
                      );
                    }}
                  />
                  {describeEvent(event)}
                </label>
              ) : (
                describeEvent(event)
              )}
              <small> +{event.elapsedMs} ms</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No fetch/XHR activity or console errors were captured.</p>
      )}
    </>
  );

  return (
    <div className="gyro-trace-panel">
      <h3>Trace</h3>
      {pending && <p role="status">{pending}</p>}
      {error && <p role="alert">{error}</p>}
      {report ? (
        <>
          <p>{report.setup.question}</p>
          <div className="gyro-trace-models">
            {[report.setup.browserModel, report.setup.sourceModel].map(
              (model, index) => (
                <span key={index}>
                  <ProviderLogo providerId={model.providerId} />{" "}
                  {index ? "Source" : "Browser"} · {modelLabel(model)}
                </span>
              ),
            )}
          </div>
          {report.partial && <p>{report.partial}</p>}
          {report.errors.map((message) => (
            <p key={message} role="status">
              {message}
            </p>
          ))}
          <section>
            <h4>Observed in the browser</h4>
            {eventList(report.approvedEvidence)}
            {report.browserFindings.map((finding, index) => (
              <p key={index}>{finding.text}</p>
            ))}
          </section>
          <section>
            <h4>
              {report.setup.revision
                ? `Supplied revision ${report.setup.revision.slice(0, 12)}`
                : "Likely matches in local checkout"}
            </h4>
            {report.sourceFindings.length === 0 && (
              <p>No supported source match.</p>
            )}
            {report.sourceFindings.map((finding, index) => {
              const excerpt = report.excerpts.find(
                (excerpt) => excerpt.id === finding.excerptId,
              );
              const event = report.approvedEvidence.events.find(
                (event) => event.id === finding.eventId,
              );
              if (!excerpt || !finding.line || !event) return null;
              const line = finding.line;
              return (
                <article key={index}>
                  <p>
                    {describeEvent(event)} →{" "}
                    <button
                      type="button"
                      className="gyro-review-citation"
                      onClick={() =>
                        void action("Checking source…", async () => {
                          const opened = await runtime.openSource(
                            report.id,
                            excerpt.id,
                            line,
                          );
                          setSnippet(opened ? undefined : excerpt);
                        })
                      }
                    >
                      {excerpt.path}:{line}
                    </button>
                  </p>
                  <p>{finding.text}</p>
                </article>
              );
            })}
            {snippet && (
              <details open>
                <summary>
                  Captured source · {snippet.path}:{snippet.firstLine}
                </summary>
                <pre>
                  {snippet.lines
                    .map(
                      (line, index) => `${snippet.firstLine + index}  ${line}`,
                    )
                    .join("\n")}
                </pre>
              </details>
            )}
          </section>
          <div className="gyro-trace-actions">
            <button
              type="button"
              className="gyro-review-primary"
              disabled={!report.sourceFindings.length}
              onClick={() =>
                draftFix(
                  `Investigate and fix this trace: ${report.setup.question}\n\n${report.sourceFindings
                    .map((finding) => {
                      const excerpt = report.excerpts.find(
                        (item) => item.id === finding.excerptId,
                      );
                      return `- ${excerpt?.path}:${finding.line} — ${finding.text}`;
                    })
                    .join("\n")}`,
                )
              }
            >
              Draft fix
            </button>
            <button
              type="button"
              className="gyro-review-secondary"
              onClick={() => {
                setReport(undefined);
                setSnippet(undefined);
              }}
            >
              New trace
            </button>
          </div>
        </>
      ) : run.id ? (
        <>
          <p role="status">
            {capture?.done
              ? (capture.partial ?? "Review the capture")
              : capture?.evidence.click
                ? "Capturing browser activity…"
                : "Click the control that reproduces the bug."}
          </p>
          {capture?.done && (
            <>
              {eventList(capture.evidence, true)}
              <div className="gyro-trace-actions">
                <button
                  type="button"
                  className="gyro-review-secondary"
                  disabled={
                    !!pending ||
                    capture.evidence.events.every((event) =>
                      excluded.includes(event.id),
                    )
                  }
                  onClick={() =>
                    void action("Preparing evidence…", async () => {
                      setReview(
                        await runtime.review(
                          run.id!,
                          capture.evidence.events
                            .filter((event) => !excluded.includes(event.id))
                            .map((event) => event.id),
                          locations,
                        ),
                      );
                    })
                  }
                >
                  {locations ? "Update payloads" : "Prepare model payloads"}
                </button>
              </div>
              {(review || locations) && (
                <section>
                  <h4>Code excerpts</h4>
                  {(
                    locations ??
                    review?.excerpts.map((excerpt) => ({
                      path: excerpt.path,
                      line:
                        excerpt.firstLine +
                        Math.min(10, excerpt.lines.length - 1),
                    })) ??
                    []
                  ).map((location, index, current) => (
                    <p key={`${location.path}:${index}`}>
                      {location.path}:{location.line}{" "}
                      <button
                        type="button"
                        disabled={!!pending}
                        className="gyro-review-secondary"
                        onClick={() => {
                          setLocations(
                            current.filter((_, item) => item !== index),
                          );
                          setReview(undefined);
                        }}
                      >
                        Remove
                      </button>
                    </p>
                  ))}
                  <label>
                    Workspace-relative path
                    <input
                      value={path}
                      onChange={(event) => setPath(event.target.value)}
                    />
                  </label>
                  <label>
                    Line
                    <input
                      type="number"
                      min={1}
                      value={line}
                      onChange={(event) => setLine(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="gyro-review-secondary"
                    disabled={
                      !path.trim() ||
                      !Number.isInteger(Number(line)) ||
                      Number(line) < 1 ||
                      !!pending ||
                      (locations?.length ?? review?.excerpts.length ?? 0) >= 6
                    }
                    onClick={() => {
                      setLocations([
                        ...(locations ??
                          review?.excerpts.map((excerpt) => ({
                            path: excerpt.path,
                            line:
                              excerpt.firstLine +
                              Math.min(10, excerpt.lines.length - 1),
                          })) ??
                          []),
                        { path: path.trim(), line: Number(line) },
                      ]);
                      setPath("");
                      setReview(undefined);
                    }}
                  >
                    Add excerpt
                  </button>
                </section>
              )}
              {review && (
                <section aria-label="Review model inputs">
                  <details open>
                    <summary>
                      Browser model payload
                      {capture.browserModel &&
                        ` · ${modelLabel(capture.browserModel)}`}
                    </summary>
                    <pre>{JSON.stringify(review.browserInput, null, 2)}</pre>
                  </details>
                  <details open>
                    <summary>
                      Source model payload
                      {capture.sourceModel &&
                        ` · ${modelLabel(capture.sourceModel)}`}
                    </summary>
                    <pre>{JSON.stringify(review.sourceInput, null, 2)}</pre>
                  </details>
                  <button
                    className="gyro-review-primary"
                    type="button"
                    disabled={!!pending}
                    onClick={() =>
                      void action("Analyzing with both models…", async () => {
                        const result = await runtime.analyze(
                          run.id!,
                          review.id,
                        );
                        setReport(result);
                        setReports((history) => [result, ...history]);
                        run.clear();
                        setReview(undefined);
                        setLocations(undefined);
                        setExcluded([]);
                      })
                    }
                  >
                    Approve and analyze
                  </button>
                </section>
              )}
            </>
          )}
          <div className="gyro-trace-actions">
            {!capture?.done && (
              <button
                type="button"
                className="gyro-review-secondary"
                onClick={openBrowser}
              >
                Show browser
              </button>
            )}
            <button
              type="button"
              className="gyro-review-secondary"
              disabled={!!pending}
              onClick={() =>
                void action("Discarding capture…", async () => {
                  await runtime.discard(run.id!);
                  run.clear();
                  setReview(undefined);
                  setLocations(undefined);
                  setExcluded([]);
                })
              }
            >
              Discard trace
            </button>
          </div>
        </>
      ) : (
        <>
          <label>
            Question
            <textarea
              ref={questionRef}
              rows={2}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <label>
            Browser origin
            <input
              placeholder="http://localhost:3000"
              value={selectedOrigin}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          <label>
            Workspace root
            <select
              value={rootId}
              onChange={(event) => setRootId(event.target.value)}
            >
              {runtime.roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.path}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>API origin and source revision</summary>
            <label>
              Additional API origin
              <input
                value={apiOrigin}
                onChange={(event) => setApiOrigin(event.target.value)}
              />
            </label>
            <label>
              Git commit SHA
              <input
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
              />
            </label>
          </details>
          <div className="gyro-trace-models">
            {modelButton("browser", browserModel)}
            {modelButton("source", sourceModel)}
          </div>
          {picker && (
            <div className="gyro-trace-picker">
              <ComposerReviewerPicker
                textarea={questionRef}
                inline
                normalChat
                options={options.filter(
                  (model) =>
                    !matchModel(
                      model,
                      picker === "browser" ? sourceModel : browserModel,
                    ),
                )}
                selected={picker === "browser" ? browserModel : sourceModel}
                copy={{
                  title: `Choose ${picker} model`,
                  description: "This model receives the evidence you approve.",
                  removeLabel: "Clear model",
                }}
                onChoose={(model) => {
                  (picker === "browser" ? setBrowserModel : setSourceModel)(
                    model,
                  );
                  setPicker(undefined);
                }}
                onRemove={() => {
                  (picker === "browser" ? setBrowserModel : setSourceModel)(
                    undefined,
                  );
                  setPicker(undefined);
                }}
                onDismiss={() => setPicker(undefined)}
              />
            </div>
          )}
          {!browserOrigin || selectedOrigin !== browserOrigin ? (
            <p>
              Open the target origin in this chat’s browser, then return to
              Trace.
            </p>
          ) : null}
          <div className="gyro-trace-actions">
            <button
              type="button"
              className="gyro-review-secondary"
              onClick={openBrowser}
            >
              Open browser
            </button>
            <button
              type="button"
              className="gyro-review-primary"
              disabled={!canStart || !!pending}
              onClick={() =>
                void action("Starting capture…", async () => {
                  const id = await runtime.start({
                    question,
                    origin: selectedOrigin,
                    apiOrigin: apiOrigin.trim() || undefined,
                    rootId,
                    revision: revision.trim() || undefined,
                    browserModel: {
                      providerId: browserModel!.providerId,
                      modelId: browserModel!.modelId,
                    },
                    sourceModel: {
                      providerId: sourceModel!.providerId,
                      modelId: sourceModel!.modelId,
                    },
                  });
                  run.begin(id);
                  openBrowser();
                })
              }
            >
              Start capture
            </button>
          </div>
          {reports.length > 0 && (
            <details>
              <summary>Past traces</summary>
              {reports.map((item) => (
                <p key={item.id}>
                  <button
                    className="gyro-review-citation"
                    type="button"
                    onClick={() => setReport(item)}
                  >
                    {item.setup.question}
                  </button>
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}
