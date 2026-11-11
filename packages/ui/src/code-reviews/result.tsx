import { FeatureUsageLine } from "../feature-usage";
import { useEffect, useRef, useState } from "react";
import { PlainDiffView } from "../plain-diff-view";
import {
  reviewIsActive,
  type CodeReviewDetail,
  type CodeReviewFinding,
  type CodeReviewRuntime,
} from "./types";

export function CodeReviewResult({
  detail,
  runtime,
  onChanged,
  onReviewAgain,
  onComposeFix,
  onDeleted,
}: {
  detail: CodeReviewDetail;
  runtime: CodeReviewRuntime;
  onChanged: () => void;
  onReviewAgain: () => void;
  onComposeFix?: (message: string) => boolean;
  onDeleted: () => void;
}) {
  const { run, snapshot } = detail;
  const [finding, setFinding] = useState<CodeReviewFinding>();
  const [diff, setDiff] = useState<string>();
  const [raw, setRaw] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [useCurrent, setUseCurrent] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const request = useRef(0);
  const [queueAfterCurrent, setQueueAfterCurrent] = useState(false);
  const fixOperation = useRef(crypto.randomUUID());
  useEffect(() => {
    fixOperation.current = crypto.randomUUID();
    setQueueAfterCurrent(false);
  }, [selected.join(","), detail.targetFingerprint]);
  useEffect(() => {
    setFinding(undefined);
    setDiff(undefined);
    setRaw(undefined);
    setError("");
    setNotice("");
    setSelected([]);
    setUseCurrent(false);
    setConfirmDelete(false);
    setBusy(false);
    return () => {
      request.current++;
    };
  }, [run.id, runtime.key]);
  useEffect(() => {
    setFinding((previous) =>
      run.findings.find((item) => item.id === previous?.id),
    );
    setSelected((current) =>
      current.filter((id) =>
        run.findings.some(
          (item) =>
            item.id === id &&
            !["dismissed", "resolved-by-review"].includes(item.disposition),
        ),
      ),
    );
  }, [run.revision]);
  useEffect(() => setUseCurrent(false), [detail.targetFingerprint]);
  async function act(action: string, payload: Record<string, unknown> = {}) {
    const generation = ++request.current;
    setBusy(true);
    setError("");
    try {
      await runtime.request(action, {
        reviewId: run.id,
        revision: run.revision,
        ...payload,
      });
      if (generation === request.current) {
        if (action === "delete") onDeleted();
        else onChanged();
      }
    } catch (error) {
      if (generation === request.current) setError(String(error));
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  async function inspect(selected: CodeReviewFinding) {
    if (busy) return;
    const generation = ++request.current;
    setFinding(selected);
    setDiff(undefined);
    setError("");
    try {
      const result = await runtime.request<{ diff: string }>("file", {
        reviewId: run.id,
        path: selected.path,
      });
      if (generation === request.current) setDiff(result.diff);
    } catch (error) {
      if (generation === request.current) setError(String(error));
    }
  }
  async function showRaw(action: "raw" | "input" = "raw") {
    if (busy) return;
    const generation = ++request.current;
    try {
      const result = await runtime.request<{ output?: string; input?: string }>(
        action,
        {
          reviewId: run.id,
        },
      );
      if (generation === request.current)
        setRaw(result.input ?? result.output ?? "No output was captured.");
    } catch (error) {
      if (generation === request.current) setError(String(error));
    }
  }
  async function prepareFixes() {
    if (!onComposeFix) return;
    const generation = ++request.current;
    setBusy(true);
    setError("");
    try {
      const result = await runtime.request<{ message: string }>("fix-draft", {
        reviewId: run.id,
        revision: run.revision,
        findingIds: selected,
        targetFingerprint: detail.targetFingerprint,
        useCurrentRevision: useCurrent,
      });
      if (generation === request.current) {
        if (!onComposeFix(result.message))
          setError(
            "The composer already contains a draft. Send or clear it before adding a fix request.",
          );
        else
          setNotice(
            "Fix request added to the composer. Review it and send when ready.",
          );
      }
    } catch (error) {
      if (generation === request.current) setError(String(error));
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  return (
    <section className="gyro-second-opinion-result" aria-label="Review result">
      <div className="gyro-review-run-status" role="status">
        <strong>{run.status}</strong>
        <span>
          {run.providerId} · {run.modelId}
        </span>
      </div>
      <p>
        {snapshot.rootPath ?? snapshot.rootId}{" "}
        {snapshot.headOid ? `· ${snapshot.headOid.slice(0, 12)}` : ""}
      </p>
      <p>
        {run.suppliedFiles} of {run.intendedFiles} files supplied ·{" "}
        {detail.freshness.replaceAll("-", " ")}
      </p>
      {reviewIsActive(run.status) ? (
        <button disabled={busy} onClick={() => void act("cancel")}>
          Stop review
        </button>
      ) : (
        <button
          className={!selected.length ? "gyro-review-primary" : undefined}
          onClick={onReviewAgain}
        >
          Review again
        </button>
      )}
      <FeatureUsageLine
        usage={detail.usage}
        createdAt={run.createdAt}
        finishedAt={run.finishedAt}
      />
      {run.status === "queued" ? (
        <p role="status">Queued for provider admission.</p>
      ) : null}
      {run.error ? <p role="alert">{run.error}</p> : null}
      {run.summary ? <p>{run.summary}</p> : null}
      {run.status === "completed" && !run.findings.length ? (
        <p>
          No findings reported in the supplied files. This is not proof of
          correctness.
        </p>
      ) : null}
      {run.status === "incomplete" ? (
        <p>
          Incomplete review. Unassessed changes and previous findings remain
          open.
        </p>
      ) : null}
      {run.limitations.map((text, index) => (
        <p key={index}>{text}</p>
      ))}
      {snapshot.exclusions.length ? (
        <details>
          <summary>{snapshot.exclusions.length} excluded files</summary>
          {snapshot.exclusions.map((item) => (
            <p key={item.path}>
              {item.path}: {item.reason}
            </p>
          ))}
        </details>
      ) : null}
      <ul className="gyro-review-findings">
        {run.findings.map((item) => (
          <li key={item.id}>
            {onComposeFix &&
            !reviewIsActive(run.status) &&
            !["dismissed", "resolved-by-review"].includes(item.disposition) ? (
              <label className="gyro-review-finding-select">
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, item.id]
                        : current.filter((id) => id !== item.id),
                    )
                  }
                  aria-label={`Select for fixes: ${item.title}`}
                />
              </label>
            ) : null}
            <button
              aria-pressed={finding?.id === item.id}
              onClick={() => void inspect(item)}
            >
              <strong>
                {item.severity} · {item.title}
              </strong>
              <span>
                {item.path}:{item.lineStart} ·{" "}
                {item.disposition.replaceAll("-", " ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected.length ? (
        <div>
          {detail.freshness !== "current" ? (
            <label>
              <input
                type="checkbox"
                checked={useCurrent}
                onChange={(event) => setUseCurrent(event.target.checked)}
              />
              Use the current revision; captured locations are historical
            </label>
          ) : null}
          <button
            disabled={busy || (detail.freshness !== "current" && !useCurrent)}
            onClick={() => void prepareFixes()}
          >
            Add {selected.length} selected fixes to composer
          </button>
          <p>
            Review the request and send it through the chat. Adding a draft does
            not apply or approve edits.
          </p>
        </div>
      ) : null}
      {selected.length &&
      detail.fixTarget?.providerId &&
      detail.fixTarget.modelId ? (
        <section aria-label="Send selected findings for fixes">
          <p>
            Send through {detail.fixTarget.providerId} ·{" "}
            {detail.fixTarget.modelId} in Normal chat with current project
            policy and approvals.
          </p>
          <label className="gyro-review-finding-select">
            <input
              type="checkbox"
              checked={queueAfterCurrent}
              onChange={(event) => setQueueAfterCurrent(event.target.checked)}
            />
            Queue after the current turn if this checkout is busy
          </label>
          <button
            className="gyro-review-primary"
            disabled={busy || (detail.freshness !== "current" && !useCurrent)}
            onClick={() =>
              void act("send-fixes", {
                operationId: fixOperation.current,
                findingIds: selected,
                targetFingerprint: detail.targetFingerprint,
                useCurrentRevision: useCurrent,
                providerId: detail.fixTarget?.providerId,
                modelId: detail.fixTarget?.modelId,
                queueAfterCurrent,
              })
            }
          >
            Send {selected.length} selected findings for fixes
          </button>
          <p>
            Sending starts a chat turn. It does not apply or approve edits. Only
            a new completed review can resolve a finding.
          </p>
        </section>
      ) : null}
      {detail.fixIntents?.length ? (
        <section aria-label="Fix requests">
          <h3>Fix requests</h3>
          {detail.fixIntents.map((intent) => (
            <div key={intent.id}>
              <p>
                {intent.status} · {intent.providerId} · {intent.modelId}
              </p>
              <p>Implementing turn: {intent.turnId}</p>
              {intent.error ? <p role="alert">{intent.error}</p> : null}
              {["queued", "dispatching", "sent"].includes(intent.status) ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act("cancel-fixes", { intentId: intent.id })
                  }
                >
                  Cancel fix request
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {finding ? (
        <section aria-label="Selected finding">
          <h4>{finding.title}</h4>
          <p>{finding.explanation}</p>
          {finding.suggestedResolution ? (
            <p>{finding.suggestedResolution}</p>
          ) : null}
          <p>
            Captured {finding.side} lines {finding.lineStart}–{finding.lineEnd}.
            Current files may differ.
          </p>
          {finding.disposition !== "dismissed" &&
          !reviewIsActive(run.status) ? (
            <button
              disabled={busy}
              onClick={() => void act("dismiss", { findingId: finding.id })}
            >
              Dismiss finding
            </button>
          ) : null}
          {diff !== undefined ? (
            <PlainDiffView diff={diff} lead="Captured revision" />
          ) : (
            <p role="status">Loading captured diff…</p>
          )}
        </section>
      ) : null}
      <details>
        <summary>Captured input and output</summary>
        <p>
          {snapshot.capturedAt} · {snapshot.capturedBytes.toLocaleString()}{" "}
          bytes · {snapshot.manifestHash.slice(0, 12)}
        </p>
        <p>{snapshot.request}</p>
        <button onClick={() => void showRaw("input")}>
          Inspect exact input
        </button>
        <button onClick={() => void showRaw()}>Inspect raw output</button>
        {raw !== undefined ? <pre>{raw}</pre> : null}
      </details>
      {!reviewIsActive(run.status) ? (
        confirmDelete ? (
          <div>
            <p>
              Delete this review and its captured input/output? Snapshots used
              by another review are retained.
            </p>
            <button disabled={busy} onClick={() => void act("delete")}>
              Delete review
            </button>
            <button onClick={() => setConfirmDelete(false)}>Keep review</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)}>Delete review…</button>
        )
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
