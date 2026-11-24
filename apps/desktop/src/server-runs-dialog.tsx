import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Dialog,
  Input,
  PlainDiffView,
  Select,
  SettingsStatus,
  Textarea,
} from "@gyro-dev/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import "./server-runs-dialog.css";

type RunState = "starting" | "running" | "committing" | "done" | "failed" | "timeout" | "stopped" | "lost";
type RunStatus = { state: RunState; canReview: boolean };
type Run = {
  id: string;
  hostId: string;
  state: RunState;
  resultCommit?: string;
  createdAt: number;
};
type RunBatch = {
  status: RunStatus;
  offset: number;
  output: string[];
  signedOut: boolean;
  finished: boolean;
};
type Review = { branch: string; files: string[] };
type Request =
  | { action: "list"; workspacePath: string }
  | { action: "start"; workspacePath: string; host: string; task: string }
  | { action: "read"; runId: string; offset: number }
  | { action: "stop" | "review"; runId: string }
  | { action: "fileDiff"; runId: string; path: string };

const stateLabels: Record<RunState, string> = {
  starting: "Starting",
  running: "Running",
  committing: "Saving result",
  done: "Completed",
  failed: "Run failed",
  timeout: "Timed out",
  stopped: "Stopped",
  lost: "Server runner exited",
};

function requestRun<T>(request: Request) {
  return invoke<T>("server_runs_request", { request });
}

function runLabel(run: Run) {
  return `${run.hostId} · ${new Date(run.createdAt * 1000).toLocaleString()}`;
}

export function ServerRunsDialog({
  workspacePath,
  onClose,
  onBranchFetched,
}: {
  workspacePath: string;
  onClose: () => void;
  onBranchFetched: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState({ host: "", task: "" });
  const [catalog, setCatalog] = useState<{ runs: Run[]; aliases: string[] }>();
  const [selectedId, setSelectedId] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [launchMessage, setLaunchMessage] = useState<string>();
  const [launching, setLaunching] = useState(false);
  const [showForm, setShowForm] = useState<boolean>();
  const launchPending = useRef(false);
  const activityHeading = useRef<HTMLElement>(null);
  const runs = catalog?.runs ?? [];
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const formVisible = showForm ?? !selected;

  const load = useCallback(async () => {
    setListError(undefined);
    try {
      setCatalog(await requestRun<{ runs: Run[]; aliases: string[] }>({ action: "list", workspacePath }));
    } catch (error) {
      setListError(String(error));
    }
  }, [workspacePath]);

  useEffect(() => { void load(); }, [load]);

  async function launch() {
    if (launchPending.current) return;
    launchPending.current = true;
    setLaunching(true);
    setLaunchMessage(undefined);
    try {
      const { run, warning } = await requestRun<{ run: Run; warning?: string }>({
        action: "start", workspacePath, host: form.host, task: form.task,
      });
      setCatalog((previous) => ({
        aliases: previous?.aliases ?? [],
        runs: [run, ...(previous?.runs ?? []).filter((saved) => saved.id !== run.id)],
      }));
      setSelectedId(run.id);
      setShowForm(false);
      requestAnimationFrame(() => activityHeading.current?.focus());
      if (warning) {
        setLaunchMessage(`Start could not be confirmed. Check the saved run before trying again. ${warning}`);
      } else {
        setForm((previous) => ({ ...previous, task: "" }));
      }
    } catch (error) {
      setLaunchMessage(String(error));
    } finally {
      launchPending.current = false;
      setLaunching(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Content
        className="gyro-server-runs-dialog"
        size="md"
        showClose
        onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
      >
        <Dialog.Header>
          <Dialog.Title>Server runs</Dialog.Title>
          <Dialog.Description>Send work from {workspacePath.split("/").filter(Boolean).at(-1)} to Codex on your Linux server.</Dialog.Description>
        </Dialog.Header>
        <Dialog.Body className="gyro-server-runs-body">
          {listError ? (
            <div className="gyro-server-runs-feedback" role="alert">
              <span>{listError}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
            </div>
          ) : !catalog ? <p role="status">Loading server runs…</p> : formVisible ? (
            <form className="gyro-server-runs-form" onSubmit={(event) => { event.preventDefault(); void launch(); }}>
              <label htmlFor={`${id}-host`}>SSH host</label>
              <Input
                id={`${id}-host`}
                value={form.host}
                list={`${id}-aliases`}
                autoComplete="off"
                spellCheck={false}
                placeholder="SSH config alias or hostname"
                onChange={(event) => setForm({ ...form, host: event.target.value })}
                disabled={launching}
                required
              />
              <datalist id={`${id}-aliases`}>
                {catalog.aliases.map((alias) => <option key={alias} value={alias} />)}
              </datalist>
              <p>Verify the host key and sign in to Codex on the server first.</p>
              <label htmlFor={`${id}-task`}>Task</label>
              <Textarea
                id={`${id}-task`}
                value={form.task}
                onChange={(event) => setForm({ ...form, task: event.target.value })}
                placeholder="Describe the change you want Codex to make"
                disabled={launching}
                maxLength={32_768}
                rows={3}
                required
              />
              <div className="gyro-server-runs-form-footer">
                <p>Gyro copies the repository, including tracked changes and untracked files that Git does not ignore.</p>
                {selected ? (
                  <Button type="button" size="sm" variant="ghost" disabled={launching} onClick={() => setShowForm(false)}>
                    Cancel
                  </Button>
                ) : null}
                <Button type="submit" size="sm" disabled={launching || !form.host.trim() || !form.task.trim()}>
                  {launching ? "Starting…" : "Run on server"}
                </Button>
              </div>
            </form>
          ) : null}
          {launchMessage ? <p role="alert">{launchMessage}</p> : null}
          {selected ? (
            <section className="gyro-server-runs-history" aria-label="Saved runs">
              <div className="gyro-server-runs-history-header">
                <strong tabIndex={-1} ref={activityHeading}>Run activity</strong>
                {runs.length > 1 ? (
                  <Select.Root value={selected.id} onValueChange={(next) => { if (next) setSelectedId(next); }}>
                    <Select.Trigger aria-label="Saved run">{runLabel(selected)}</Select.Trigger>
                    <Select.Content>
                      {runs.map((run) => <Select.Item key={run.id} value={run.id}>{runLabel(run)}</Select.Item>)}
                    </Select.Content>
                  </Select.Root>
                ) : <span>{runLabel(selected)}</span>}
                {!formVisible ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(true)}>
                    New run
                  </Button>
                ) : null}
              </div>
              <RunActivity key={selected.id} run={selected} onBranchFetched={onBranchFetched} />
            </section>
          ) : null}
        </Dialog.Body>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function RunActivity({ run, onBranchFetched }: { run: Run; onBranchFetched: () => void }) {
  const [status, setStatus] = useState<RunStatus>({ state: run.state, canReview: Boolean(run.resultCommit) });
  const [output, setOutput] = useState<string[]>([]);
  const [pollError, setPollError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [signedOut, setSignedOut] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [busy, setBusy] = useState<"stop" | "review">();
  const [review, setReview] = useState<Review>();
  const [retry, setRetry] = useState(0);
  const offset = useRef(0);
  const active = status.state === "starting" || status.state === "running" || status.state === "committing";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const batch = await requestRun<RunBatch>({ action: "read", runId: run.id, offset: offset.current });
        if (cancelled) return;
        setStatus(batch.status);
        if (batch.signedOut) setSignedOut(true);
        if (batch.output.length) setOutput((prior) => [...prior, ...batch.output].slice(-100));
        offset.current = batch.offset;
        if (!batch.finished) timer = setTimeout(() => void poll(), 1200);
      } catch (error) {
        if (!cancelled) setPollError(String(error));
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [run.id, retry]);

  async function stop() {
    setBusy("stop");
    setStopRequested(true);
    setActionError(undefined);
    try {
      await requestRun<RunStatus>({ action: "stop", runId: run.id });
      reconnect();
    } catch (error) {
      setStopRequested(false);
      setActionError(String(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function openReview() {
    setBusy("review");
    setActionError(undefined);
    try {
      setReview(await requestRun<Review>({ action: "review", runId: run.id }));
      onBranchFetched();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusy(undefined);
    }
  }

  function reconnect() {
    setPollError(undefined);
    setRetry((current) => current + 1);
  }

  return (
    <>
      <div className="gyro-server-runs-status">
        <span role="status">
          <SettingsStatus status={status.state === "done" ? "good" : "neutral"}>
            {pollError && active ? "Status unavailable" : active && stopRequested ? "Stopping…" : stateLabels[status.state]}
          </SettingsStatus>
        </span>
        {active && !pollError ? <span>Runs on the server if you close Gyro.</span> : null}
        <div className="gyro-server-runs-actions">
          {active && !stopRequested && !pollError ? (
            <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void stop()}>
              Stop
            </Button>
          ) : null}
          {status.canReview && !review ? (
            <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => void openReview()}>
              {busy === "review" ? "Fetching branch…" : "Review result"}
            </Button>
          ) : null}
        </div>
      </div>
      {pollError ? (
        <div className="gyro-server-runs-feedback" role="alert">
          <span>{pollError}</span>
          <Button type="button" size="sm" variant="outline" onClick={reconnect}>Reconnect</Button>
        </div>
      ) : null}
      {signedOut ? <p role="status">Sign in to Codex on the server and start a new run.</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {output.length && !review ? (
        <pre tabIndex={0} aria-label="Recent Codex output" className="gyro-server-runs-log">{output.join("\n\n")}</pre>
      ) : null}
      {status.state === "done" && !status.canReview ? <p>Codex finished without changes.</p> : null}
      {review ? <ResultReview runId={run.id} review={review} /> : null}
    </>
  );
}

function ResultReview({ runId, review }: { runId: string; review: Review }) {
  const [file, setFile] = useState(review.files[0] ?? "");
  const [diff, setDiff] = useState<{ unified: string; notice?: string }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setDiff(undefined);
    setError(undefined);
    if (!file) return;
    void requestRun<{ unified: string; notice?: string }>({ action: "fileDiff", runId, path: file }).then(
      (result) => { if (!cancelled) setDiff(result); },
      (reason) => { if (!cancelled) setError(String(reason)); },
    );
    return () => { cancelled = true; };
  }, [file, runId]);

  return (
    <div className="gyro-server-runs-review">
      <div className="gyro-server-runs-result">
        <strong>Result branch</strong>
        <code>{review.branch}</code>
      </div>
      {file ? (
        <Select.Root value={file} onValueChange={(next) => { if (next) setFile(next); }}>
          <Select.Trigger aria-label="Changed file">{file}</Select.Trigger>
          <Select.Content>
            {review.files.map((path) => <Select.Item key={path} value={path}>{path}</Select.Item>)}
          </Select.Content>
        </Select.Root>
      ) : <p>No file changes in this branch.</p>}
      {error ? <p role="alert">{error}</p> : null}
      {file && !error && !diff ? <p role="status">Loading diff…</p> : null}
      {diff ? <PlainDiffView key={file} diff={diff.unified} notice={diff.notice} /> : null}
    </div>
  );
}
