import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./app-preview-panel.css";

export type AppPreviewTarget = {
  id: string;
  kind: "web" | "macos" | "simulator";
  title: string;
  width: number;
  height: number;
};
export type AppPreviewObservation = {
  target: AppPreviewTarget;
  screenshot: {
    path: string;
    filename: string;
    width: number;
    height: number;
    createdAt: string;
    src?: string;
  };
  contentRect: { x: number; y: number; width: number; height: number };
  expiresAfterMs: number;
  interaction: string;
};
export type AppPreviewRuntime = {
  key: string;
  targets(): Promise<{
    selected: AppPreviewTarget;
    targets: AppPreviewTarget[];
    issues: string[];
  }>;
  select(id: string): Promise<AppPreviewTarget>;
  capture(): Promise<AppPreviewObservation>;
  click(captureId: string, x: number, y: number): Promise<unknown>;
  subscribe(listener: (capture?: AppPreviewObservation) => void): () => void;
};
const WEB: AppPreviewTarget = {
  id: "web",
  kind: "web",
  title: "Web preview",
  width: 0,
  height: 0,
};
const runtimeLabel = (target: AppPreviewTarget) =>
  target.kind === "macos"
    ? "macOS window"
    : target.kind === "simulator"
      ? "iPhone Simulator"
      : "Web preview";

/** Both people and models use the same selected target and framed capture. */
export function AppPreviewPanel({
  runtime,
  children,
  onHideWeb,
}: {
  runtime: AppPreviewRuntime;
  children: ReactNode;
  onHideWeb?: () => void;
}) {
  const [target, setTarget] = useState(WEB);
  const [loaded, setLoaded] = useState(false);
  const [targets, setTargets] = useState<AppPreviewTarget[]>([WEB]);
  const [issues, setIssues] = useState<string[]>([]);
  const [capture, setCapture] = useState<AppPreviewObservation>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState(false);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const selectedId = useRef("web");
  const hideWeb = useRef(onHideWeb);
  hideWeb.current = onHideWeb;
  const refresh = useCallback(async () => {
    const revision = ++generation.current;
    setBusy(true);
    try {
      const value = await runtime.targets();
      if (generation.current !== revision) return;
      selectedId.current = value.selected.id;
      setTarget(value.selected);
      setTargets(value.targets);
      setIssues(value.issues);
      setLoaded(true);
      setCapture(undefined);
      setInspect(false);
      setError("");
      if (value.selected.kind !== "web") hideWeb.current?.();
    } catch (e) {
      if (generation.current === revision) {
        setError(String(e));
        // Older running desktop builds can still show their existing web page.
        setLoaded(true);
      }
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  }, [runtime]);
  useEffect(() => {
    void refresh();
    const unsubscribe = runtime.subscribe((observation) => {
      if (!observation) {
        void refresh();
        return;
      }
      generation.current++;
      selectedId.current = observation.target.id;
      setTarget(observation.target);
      setCapture(observation);
      setLoaded(true);
      setBusy(false);
      setError("");
      setInspect(false);
      setNow(Date.now());
      hideWeb.current?.();
    });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      generation.current++;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [runtime, refresh]);
  const select = async (id: string) => {
    const revision = ++generation.current;
    setBusy(true);
    setCapture(undefined);
    setInspect(false);
    setError("");
    try {
      const next = await runtime.select(id);
      if (generation.current !== revision) return;
      selectedId.current = next.id;
      setTarget(next);
      if (next.kind !== "web") hideWeb.current?.();
    } catch (e) {
      if (generation.current === revision) setError(String(e));
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  };
  const takeCapture = async () => {
    const revision = ++generation.current;
    setBusy(true);
    setInspect(false);
    setError("");
    try {
      const next = await runtime.capture();
      if (
        generation.current !== revision ||
        next.target.id !== selectedId.current
      )
        return;
      setCapture(next);
      setNow(Date.now());
      hideWeb.current?.();
    } catch (e) {
      if (generation.current === revision) setError(String(e));
    } finally {
      if (generation.current === revision) setBusy(false);
    }
  };
  const age = capture
    ? Math.max(0, now - Date.parse(capture.screenshot.createdAt))
    : Infinity;
  const stale = Boolean(error) || age >= (capture?.expiresAfterMs ?? 0);
  const canClick =
    Boolean(capture) && !stale && !busy && capture?.interaction === "click";
  return (
    <section
      className="gyro-app-preview"
      aria-label="App preview and inspection"
    >
      <div className="gyro-app-preview-toolbar">
        <select
          aria-label="Preview target"
          value={target.id}
          disabled={busy}
          onChange={(event) => {
            void select(event.target.value);
          }}
        >
          {!targets.some((item) => item.id === target.id) && (
            <option value={target.id}>{target.title} · disconnected</option>
          )}
          {targets.map((item) => (
            <option key={item.id} value={item.id}>
              {runtimeLabel(item)}
              {item.kind === "web" ? "" : ` · ${item.title}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          title="Discover windows and Simulator devices"
        >
          Refresh targets
        </button>
        <button
          type="button"
          onClick={() => void takeCapture()}
          disabled={busy || !loaded}
        >
          Capture
        </button>
      </div>
      {issues.length > 0 && (
        <details className="gyro-app-preview-issues">
          <summary>Runtime availability ({issues.length})</summary>
          {issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </details>
      )}
      {error && (
        <p className="gyro-app-preview-error" role="alert">
          {error}
        </p>
      )}
      {capture ? (
        <div className="gyro-app-preview-capture">
          <div className="gyro-app-preview-evidence" role="status">
            <strong>{runtimeLabel(capture.target)}</strong>
            <span>
              {stale ? "Stale capture" : "Captured"} ·{" "}
              {new Date(capture.screenshot.createdAt).toLocaleTimeString()} ·{" "}
              {Math.floor(age / 1000)}s ago
            </span>
            <span>{capture.target.title}</span>
            {capture.target.kind === "simulator" && (
              <span>
                Native device screenshot · interact in Simulator, then capture
                again
              </span>
            )}
            <div>
              {capture.target.kind !== "simulator" && (
                <button
                  type="button"
                  aria-pressed={inspect}
                  disabled={!canClick}
                  onClick={() => setInspect((value) => !value)}
                >
                  Click to inspect
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void takeCapture()}
              >
                Refresh capture
              </button>
              {target.kind === "web" && (
                <button
                  type="button"
                  onClick={() => {
                    setCapture(undefined);
                    setInspect(false);
                  }}
                >
                  Return to web page
                </button>
              )}
            </div>
          </div>
          <div className="gyro-app-preview-image">
            <img
              src={capture.screenshot.src}
              alt={`${runtimeLabel(capture.target)} capture of ${capture.target.title}`}
              className={inspect && canClick ? "is-interactive" : ""}
              onClick={async (event) => {
                if (!inspect || !canClick) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x =
                  ((event.clientX - rect.left) * capture.screenshot.width) /
                  rect.width;
                const y =
                  ((event.clientY - rect.top) * capture.screenshot.height) /
                  rect.height;
                const content = capture.contentRect;
                if (
                  x < content.x ||
                  y < content.y ||
                  x >= content.x + content.width ||
                  y >= content.y + content.height
                ) {
                  setError(
                    "The surround is not interactive. Refresh the capture and click inside its content.",
                  );
                  return;
                }
                const revision = ++generation.current;
                setBusy(true);
                setInspect(false);
                try {
                  await runtime.click(capture.screenshot.filename, x, y);
                  if (generation.current !== revision) return;
                  const next = await runtime.capture();
                  if (
                    generation.current === revision &&
                    next.target.id === selectedId.current
                  ) {
                    setCapture(next);
                    setNow(Date.now());
                  }
                } catch (e) {
                  if (generation.current === revision) setError(String(e));
                } finally {
                  if (generation.current === revision) setBusy(false);
                }
              }}
            />
          </div>
          <small className="gyro-app-preview-note">
            Snapshot, not a live stream. Coordinates include the surround;
            frame-only areas cannot receive input.
          </small>
        </div>
      ) : !loaded ? (
        <div className="gyro-app-preview-empty">Loading runtime targets…</div>
      ) : target.kind === "web" ? (
        children
      ) : (
        <div className="gyro-app-preview-empty">
          <strong>{target.title}</strong>
          <span>{runtimeLabel(target)} connected · no current capture</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void takeCapture()}
          >
            Capture selected runtime
          </button>
        </div>
      )}
      {busy && (
        <span className="gyro-app-preview-busy" role="status">
          Updating preview…
        </span>
      )}
    </section>
  );
}
