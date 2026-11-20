import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { InlineLinkRenderer } from "../chat-file-links";
import {
  getProviderModel,
  isProviderId,
  providersForConfig,
} from "../provider-catalog";
import type { GyroConfig } from "../types";
import { ProviderLogo } from "../workspace-sidebar";
import { PlainDiffView } from "../plain-diff-view";
import {
  reviewIsActive,
  type CodeReviewDetail,
  type CodeReviewFinding,
  type CodeReviewRuntime,
} from "./types";

function citation(finding: CodeReviewFinding) {
  const end = finding.lineEnd > finding.lineStart ? `–${finding.lineEnd}` : "";
  return `${finding.path}:${finding.lineStart}${end}`;
}

export type ReviewMarkdownRenderer = (
  text: string,
  renderLink: InlineLinkRenderer,
) => ReactNode;

function CapturedReviewFile({
  runtime,
  reviewId,
  path,
}: {
  runtime: CodeReviewRuntime;
  reviewId: string;
  path: string;
}) {
  const [diff, setDiff] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    runtime.request<{ diff: string }>("file", { reviewId, path }).then(
      (result) => {
        if (active) setDiff(result.diff);
      },
      (reason) => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [runtime, reviewId, path]);
  return (
    <div className="gyro-review-captured-file" aria-label={path}>
      {error ? (
        <p role="alert">{error}</p>
      ) : diff === undefined ? (
        <p role="status">Loading captured diff…</p>
      ) : (
        <PlainDiffView diff={diff} lead={`Captured revision · ${path}`} />
      )}
    </div>
  );
}

export function ReviewDocument({
  config,
  detail,
  runtime,
  onOpenFile,
  onDraft,
  renderMarkdown,
}: {
  config?: GyroConfig;
  detail: CodeReviewDetail;
  runtime: CodeReviewRuntime;
  onOpenFile?: (path: string, line: number) => void;
  onDraft?: (message: string, button: HTMLButtonElement) => void;
  renderMarkdown: ReviewMarkdownRenderer;
}) {
  const { run } = detail;
  const provider = useMemo(
    () =>
      config &&
      providersForConfig(config).find((item) => item.id === run.providerId),
    [config, run.providerId],
  );
  const modelName =
    (provider && getProviderModel(provider, run.modelId)?.displayName) ||
    run.modelId;
  const [capturedPath, setCapturedPath] = useState<string>();
  const root = detail.snapshot.rootPath?.replace(/\/$/, "");
  function fileReference(
    label: string,
    path: string,
    line: number,
    original = false,
  ) {
    const file = detail.snapshot.files.find((item) => item.path === path);
    if (!file || path.startsWith("/") || path.split("/").includes(".."))
      return label;
    if (
      root !== undefined &&
      onOpenFile &&
      detail.freshness === "current" &&
      file.status !== "deleted" &&
      !original
    ) {
      const absolute = root + "/" + path;
      const href =
        "file://" +
        absolute.split("/").map(encodeURIComponent).join("/") +
        "#L" +
        line;
      return (
        <a
          className="gyro-review-citation"
          href={href}
          title={`Open ${path}:${line} in the editor`}
          onClick={(event) => {
            event.preventDefault();
            onOpenFile(absolute, line);
          }}
        >
          {label}
        </a>
      );
    }
    return (
      <button
        className="gyro-review-citation"
        type="button"
        aria-expanded={capturedPath === path}
        title={`Show captured diff for ${path}`}
        onClick={() =>
          setCapturedPath((current) => (current === path ? undefined : path))
        }
      >
        {label}
      </button>
    );
  }
  function markdownLink(label: string, target: string) {
    if (/^https?:\/\//i.test(target)) return undefined;
    let path: string;
    try {
      if (target.startsWith("file://")) {
        const url = new URL(target);
        if (url.hostname && url.hostname !== "localhost") return label;
        path = decodeURIComponent(url.pathname) + url.hash;
      } else {
        path = decodeURIComponent(target);
      }
    } catch {
      return label;
    }
    const location = path.match(/(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/);
    if (location) path = path.slice(0, location.index);
    if (root !== undefined && path.startsWith(root + "/"))
      path = path.slice(root.length + 1);
    return fileReference(
      label,
      path.replace(/^\.\//, ""),
      Math.max(1, Number(location?.[1] ?? location?.[2] ?? 1)),
    );
  }
  const prose = (text: string) => renderMarkdown(text, markdownLink);
  const ready = run.status === "completed" || run.status === "incomplete";
  const unresolved = run.findings.filter(
    (item) =>
      item.disposition !== "dismissed" &&
      item.disposition !== "resolved-by-review",
  );
  const message = unresolved.length
    ? [
        "Fix the following second-opinion findings. Check them against the current files before editing.",
        ...unresolved.map((item) =>
          [
            `${item.title} (${citation(item)})`,
            item.explanation,
            item.suggestedResolution,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ].join("\n\n")
    : [
        "Help me follow up on this second opinion.",
        run.summary,
        ...run.limitations,
      ]
        .filter(Boolean)
        .join("\n\n");
  return (
    <article className="gyro-review-document" aria-label="Second opinion">
      <header className="gyro-review-document-header">
        <h2>Second opinion</h2>
        <span
          className="gyro-review-author"
          title={`${provider?.displayName ?? run.providerId} · ${modelName}`}
        >
          <ProviderLogo
            providerId={
              isProviderId(run.providerId)
                ? run.providerId
                : `custom:${run.providerId}`
            }
            label={provider?.displayName ?? run.providerId}
          />
          <span>{modelName}</span>
        </span>
      </header>
      {reviewIsActive(run.status) && (
        <p role="status">The reviewer is working…</p>
      )}
      {run.status === "incomplete" && (
        <p className="gyro-review-document-note">
          The reviewer could only check part of the change.
        </p>
      )}
      {run.status === "cancelled" && <p>The second opinion was cancelled.</p>}
      {run.status === "failed" && <p>The second opinion failed.</p>}
      {run.error && <p role="alert">{run.error}</p>}
      {run.summary && prose(run.summary)}
      {run.status === "completed" && !run.summary && !run.findings.length && (
        <p>The reviewer reported no findings.</p>
      )}
      {detail.freshness !== "current" && run.findings.length > 0 && (
        <p className="gyro-review-document-note">
          File links show the changes captured for this review.
        </p>
      )}
      {run.findings.map((item) => (
        <section key={item.id}>
          <h3>{item.title}</h3>
          {fileReference(
            citation(item),
            item.path,
            item.lineStart,
            item.side === "original",
          )}
          {prose(item.explanation)}
          {item.suggestedResolution && prose(item.suggestedResolution)}
          {item.disposition !== "open" && (
            <p className="gyro-review-document-note">
              {item.disposition.replaceAll("-", " ")}
            </p>
          )}
        </section>
      ))}
      {run.limitations.map((text, index) => (
        <div key={index}>{prose(text)}</div>
      ))}
      {capturedPath && (
        <CapturedReviewFile
          key={capturedPath}
          runtime={runtime}
          reviewId={run.id}
          path={capturedPath}
        />
      )}
      {ready && (
        <button
          type="button"
          className="gyro-review-draft-button"
          disabled={!onDraft}
          title={
            onDraft
              ? "Add an editable prompt to this chat"
              : "Finish the current composer action to add a prompt"
          }
          onClick={(event) => onDraft?.(message, event.currentTarget)}
        >
          {unresolved.length ? "Fix in chat" : "Prompt in chat"}
        </button>
      )}
    </article>
  );
}
