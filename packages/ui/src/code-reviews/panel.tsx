import { ReviewSetupForm } from "./setup";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReviewScope } from "../review-scope";
import { CodeReviewResult } from "./result";
import {
  reviewIsActive,
  type CodeReviewDetail,
  type CodeReviewEntryRequest,
  type CodeReviewRun,
  type CodeReviewRuntime,
  type CodeReviewScope,
  type CodeReviewSnapshot,
  type ReviewerSetup,
} from "./types";
import "./review.css";

/** Existing Review destination: local Changes / Second opinion views. */
export function CodeReviewPanel({
  runtime,
  scope,
  changes,
  onComposeFix,
  entry,
}: {
  entry?: CodeReviewEntryRequest;
  runtime?: CodeReviewRuntime;
  scope: ReviewScope;
  changes: ReactNode;
  onComposeFix?: (message: string) => boolean;
}) {
  const [tab, setTab] = useState<"changes" | "opinion">("changes");
  const [setup, setSetup] = useState<ReviewerSetup>();
  const [rootId, setRootId] = useState<string>();
  const [providerId, setProvider] = useState("");
  const [modelId, setModel] = useState("");
  const [scopeKind, setScope] = useState<CodeReviewScope["kind"]>(
    scope.kind === "turn"
      ? "turn"
      : scope.kind === "branch"
        ? "branch"
        : "uncommitted",
  );
  const [turnId, setTurnId] = useState(
    scope.kind === "turn" ? scope.turnId : "",
  );
  const operationGeneration = useRef(0);
  const operationId = useRef(crypto.randomUUID());
  const [base, setBase] = useState("");
  const [brief, setBrief] = useState("");
  const [paths, setPaths] = useState("");
  const [snapshot, setSnapshot] = useState<CodeReviewSnapshot>();
  const [input, setInput] = useState<string>();
  const [runs, setRuns] = useState<CodeReviewRun[]>([]);
  const [selectedId, setSelected] = useState<string>();
  const [detail, setDetail] = useState<CodeReviewDetail>();
  const [previous, setPrevious] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const alive = useRef(true);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const setupContainer = useRef<HTMLDivElement>(null);
  const hadPreview = useRef(false);
  useEffect(() => {
    if (snapshot) previewHeading.current?.focus();
    else if (hadPreview.current)
      setupContainer.current
        ?.querySelector<HTMLSelectElement>("select")
        ?.focus();
    hadPreview.current = Boolean(snapshot);
  }, [snapshot]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      operationGeneration.current++;
      detailGeneration.current++;
    };
  }, [runtime?.key]);
  useEffect(() => {
    if (!entry) return;
    operationGeneration.current++;
    operationId.current = crypto.randomUUID();
    setTab("opinion");
    setRootId(entry.rootId);
    setScope(entry.scope.kind);
    setTurnId(entry.scope.kind === "turn" ? entry.scope.turnId : "");
    setBase(entry.scope.kind === "branch" ? entry.scope.base : "");
    setPaths(entry.paths?.join("\n") ?? "");
    setSnapshot(undefined);
    setInput(undefined);
    setPrevious(undefined);
    setSelected(undefined);
    setDetail(undefined);
    setBusy(false);
    setError("");
  }, [entry?.token]);
  const load = useCallback(async () => {
    if (!runtime) return;
    const sequence = ++generation.current;
    setError("");
    try {
      const [next, list] = await Promise.all([
        runtime.request<ReviewerSetup>("reviewers", {}, rootId),
        runtime.request<CodeReviewRun[]>("list"),
      ]);
      if (sequence !== generation.current || !alive.current) return;
      setSetup(next);
      setRuns(list);
    } catch (error) {
      if (sequence === generation.current && alive.current)
        setError(String(error));
    }
  }, [runtime, rootId]);
  useEffect(() => {
    if (tab === "opinion") void load();
  }, [load, tab]);
  const loadDetail = useCallback(async () => {
    if (!runtime || !selectedId) return;
    const sequence = ++detailGeneration.current;
    try {
      const next = await runtime.request<CodeReviewDetail>("get", {
        reviewId: selectedId,
      });
      if (sequence === detailGeneration.current && alive.current)
        setDetail(next);
    } catch (error) {
      if (sequence === detailGeneration.current && alive.current)
        setError(String(error));
    }
  }, [runtime, selectedId]);
  useEffect(() => {
    setDetail(undefined);
    void loadDetail();
    return () => {
      detailGeneration.current++;
    };
  }, [loadDetail]);
  useEffect(
    () =>
      runtime?.subscribe(() => {
        void load();
        void loadDetail();
      }),
    [runtime, load, loadDetail],
  );
  // Events invalidate durable state. Poll active runs only as a missed-event fallback.
  useEffect(() => {
    if (
      !detail ||
      (!reviewIsActive(detail.run.status) &&
        !detail.fixIntents?.some((intent) =>
          ["queued", "dispatching", "sent"].includes(intent.status),
        ))
    )
      return;
    const timer = window.setInterval(() => void loadDetail(), 3000);
    return () => clearInterval(timer);
  }, [detail?.run.id, detail?.run.status, detail?.fixIntents, loadDetail]);
  const effectiveRoot = rootId ?? setup?.rootId;
  function resetCapture() {
    operationGeneration.current++;
    setBusy(false);
    setSnapshot(undefined);
    setInput(undefined);
    setError("");
  }
  async function capture() {
    if (!runtime) return;
    const sequence = ++operationGeneration.current;
    setBusy(true);
    setError("");
    try {
      let selectedScope: CodeReviewScope = { kind: "uncommitted" };
      if (scopeKind === "branch") selectedScope = { kind: "branch", base };
      if (scopeKind === "turn") {
        if (!turnId)
          throw new Error(
            "Open Review from a recorded turn to select its historical changes.",
          );
        selectedScope = { kind: "turn", turnId };
      }
      const next = await runtime.request<CodeReviewSnapshot>(
        "capture",
        {
          scope: selectedScope,
          paths: paths
            .split("\n")
            .map((path) => path.trim())
            .filter(Boolean),
          brief: brief || undefined,
          providerId,
          modelId,
          previousReviewId: previous,
        },
        effectiveRoot,
      );
      if (sequence === operationGeneration.current && alive.current) {
        setSnapshot(next);
        operationId.current = crypto.randomUUID();
        setInput(undefined);
      }
    } catch (error) {
      if (sequence === operationGeneration.current && alive.current)
        setError(String(error));
    } finally {
      if (sequence === operationGeneration.current && alive.current)
        setBusy(false);
    }
  }
  async function start() {
    if (!runtime || !snapshot) return;
    const sequence = ++operationGeneration.current;
    setBusy(true);
    setError("");
    try {
      const run = await runtime.request<CodeReviewRun>(
        "start",
        {
          snapshotId: snapshot.id,
          operationId: operationId.current,
          providerId,
          modelId,
          previousReviewId: previous,
        },
        effectiveRoot,
      );
      if (sequence === operationGeneration.current && alive.current) {
        setSelected(run.id);
        setSnapshot(undefined);
        await load();
      }
    } catch (error) {
      if (sequence === operationGeneration.current && alive.current)
        setError(String(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function preview() {
    if (!runtime || !snapshot) return;
    const sequence = operationGeneration.current;
    try {
      const result = await runtime.request<{ input: string }>(
        "preview",
        { snapshotId: snapshot.id },
        effectiveRoot,
      );
      if (sequence === operationGeneration.current && alive.current)
        setInput(result.input);
    } catch (error) {
      if (sequence === operationGeneration.current && alive.current)
        setError(String(error));
    }
  }
  async function discardPreviews() {
    if (!runtime) return;
    const sequence = ++operationGeneration.current;
    setBusy(true);
    setError("");
    try {
      const result = await runtime.request<{ discarded: number }>(
        "discard-previews",
        {},
        effectiveRoot,
      );
      if (sequence === operationGeneration.current && alive.current) {
        setSnapshot(undefined);
        setInput(undefined);
        setNotice(`${result.discarded} preview inputs discarded`);
      }
    } catch (error) {
      if (sequence === operationGeneration.current && alive.current)
        setError(String(error));
    } finally {
      if (sequence === operationGeneration.current && alive.current)
        setBusy(false);
    }
  }
  return (
    <div className="gyro-second-opinion">
      <nav aria-label="Review views">
        <button
          aria-pressed={tab === "changes"}
          onClick={() => setTab("changes")}
        >
          Changes
        </button>
        <button
          aria-pressed={tab === "opinion"}
          onClick={() => setTab("opinion")}
        >
          Second opinion
        </button>
      </nav>
      {tab === "changes" ? (
        changes
      ) : (
        <div className="gyro-second-opinion-body">
          {!runtime ? (
            <p>Second opinions require a local project session.</p>
          ) : (
            <>
              {notice ? <p role="status">{notice}</p> : null}
              {selectedId ? (
                detail ? (
                  <CodeReviewResult
                    detail={detail}
                    runtime={runtime}
                    onComposeFix={onComposeFix}
                    onDeleted={() => {
                      setSelected(undefined);
                      setDetail(undefined);
                      void load();
                    }}
                    onChanged={() => {
                      void load();
                      void loadDetail();
                    }}
                    onReviewAgain={() => {
                      setPrevious(detail.run.id);
                      setSelected(undefined);
                      // A turn snapshot is immutable. Recheck the working files
                      // after fixes instead of reviewing that historical patch again.
                      setScope(
                        detail.snapshot.scope.kind === "branch"
                          ? "branch"
                          : "uncommitted",
                      );
                      setTurnId("");
                      setBase(
                        detail.snapshot.scope.kind === "branch"
                          ? detail.snapshot.scope.base
                          : "",
                      );
                      setPaths(
                        detail.snapshot.files
                          .map((file) => file.path)
                          .join("\n"),
                      );
                      setBrief(detail.snapshot.request ?? "");
                      setRootId(detail.snapshot.rootId);
                      setNotice(
                        "Rechecking current changes. Preview the scope; files with no current diff remain unverified.",
                      );
                      resetCapture();
                    }}
                  />
                ) : (
                  <p role="status">Loading review…</p>
                )
              ) : (
                <>
                  <header>
                    <h3>
                      {previous ? "Review again" : "Get a second opinion"}
                    </h3>
                    <p>
                      Have another model check your changes. Preview what it
                      will receive before starting.
                    </p>
                  </header>
                  {!setup ? (
                    error ? (
                      <button onClick={() => void load()}>Try again</button>
                    ) : (
                      <p role="status">Loading reviewers…</p>
                    )
                  ) : !snapshot ? (
                    <div ref={setupContainer}>
                      <ReviewSetupForm
                        setup={setup}
                        busy={busy}
                        turnId={turnId}
                        value={{
                          rootId: effectiveRoot,
                          scopeKind,
                          base,
                          providerId,
                          modelId,
                          brief,
                          paths,
                        }}
                        onCapture={() => void capture()}
                        onChange={(next) => {
                          setRootId(next.rootId);
                          setScope(next.scopeKind);
                          setBase(next.base);
                          setProvider(next.providerId);
                          setModel(next.modelId);
                          setBrief(next.brief);
                          setPaths(next.paths);
                          resetCapture();
                        }}
                      />
                    </div>
                  ) : null}
                  {snapshot ? (
                    <section aria-label="Review preview">
                      <h4 ref={previewHeading} tabIndex={-1}>
                        Ready to review
                      </h4>
                      <p className="gyro-review-context">
                        <strong>
                          {
                            setup?.reviewers.find(
                              (item) => item.id === providerId,
                            )?.label
                          }{" "}
                          · {modelId}
                        </strong>
                        <span>
                          {snapshot.rootPath} ·{" "}
                          {snapshot.scope.kind === "turn"
                            ? "This task’s changes"
                            : snapshot.scope.kind === "branch"
                              ? `Branch against ${snapshot.scope.base}`
                              : "Uncommitted changes"}
                        </span>
                      </p>
                      <strong>
                        {snapshot.files.length}{" "}
                        {snapshot.files.length === 1 ? "file" : "files"} ·{" "}
                        {snapshot.capturedBytes.toLocaleString()} bytes
                      </strong>
                      {snapshot.files.map((file) => (
                        <p key={file.path}>{file.path}</p>
                      ))}
                      {snapshot.exclusions.map((item) => (
                        <p key={item.path}>
                          Excluded {item.path}: {item.reason}
                        </p>
                      ))}
                      {!snapshot.files.length ? (
                        <p>
                          No changed files in this selection. Change the review
                          options to choose a different scope.
                        </p>
                      ) : null}
                      <p className="gyro-review-hint">
                        {setup?.reviewers.find((item) => item.id === providerId)
                          ?.transport === "local"
                          ? "Runs locally on your machine."
                          : "Starting sends this captured input to the selected provider and uses its API billing."}
                      </p>
                      <details
                        onToggle={(event) => {
                          if (event.currentTarget.open && input === undefined)
                            void preview();
                        }}
                      >
                        <summary>Exact input and capture details</summary>
                        <p>
                          Captured{" "}
                          {new Date(snapshot.capturedAt).toLocaleString()}
                        </p>
                        {input !== undefined ? (
                          <pre>{input}</pre>
                        ) : (
                          <p role="status">Loading input…</p>
                        )}
                      </details>
                      <button
                        className="gyro-review-primary"
                        disabled={busy || !snapshot.files.length}
                        onClick={() => void start()}
                      >
                        Start review · {modelId}
                      </button>
                      <button disabled={busy} onClick={resetCapture}>
                        Change setup
                      </button>
                    </section>
                  ) : null}
                </>
              )}
              <details className="gyro-review-tools">
                <summary>
                  {runs.length
                    ? `Past reviews (${runs.length}) and tools`
                    : "Review tools"}
                </summary>
                <div className="gyro-review-history">
                  <label>
                    Review history
                    <select
                      value={selectedId ?? ""}
                      onChange={(event) => {
                        setSelected(event.target.value || undefined);
                        setPrevious(undefined);
                        resetCapture();
                      }}
                    >
                      <option value="">New review</option>
                      {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          {run.status} · {run.modelId} ·{" "}
                          {new Date(run.createdAt).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void load();
                      void loadDetail();
                    }}
                  >
                    Refresh
                  </button>
                </div>
                {!selectedId ? (
                  <button
                    disabled={busy}
                    onClick={() => void discardPreviews()}
                  >
                    Clear saved previews
                  </button>
                ) : null}
              </details>
            </>
          )}
          {error ? <p role="alert">{error}</p> : null}
          {busy ? <p role="status">Working…</p> : null}
        </div>
      )}
    </div>
  );
}
