import { Button, IconButton } from "@gyro-dev/ui";
import {
  ArrowUpRight,
  Check,
  FileCode2,
  History,
  MessageSquare,
  X,
} from "@gyro-dev/ui/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  findChangeOrigin,
  originHunkLabel,
  type OriginHistory,
  type OriginHunk,
  type OriginSource,
} from "./source-control-origin";
import "./source-control-origin.css";

type Result = ReturnType<typeof findChangeOrigin>;

type Props = {
  root: string;
  path: string;
  hunk: OriginHunk;
  history?: OriginHistory;
  onRetry: () => void;
  onClose: () => void;
  onOpenChat: (
    source: OriginSource,
    draft: boolean,
    signal: AbortSignal,
  ) => Promise<void>;
};

export function ChangeOriginPanel({
  root,
  path,
  hunk,
  history,
  onRetry,
  onClose,
  onOpenChat,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const action = useRef<AbortController>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    setError("");
    setPending(false);
    return () => {
      action.current?.abort();
      action.current = undefined;
    };
  }, [hunk]);
  const result = useMemo(
    () => history && findChangeOrigin(history, root, path, hunk),
    [history, root, path, hunk],
  );

  async function openChat(source: OriginSource, draft: boolean) {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setPending(true);
    setError("");
    try {
      await onOpenChat(source, draft, controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(String(failure instanceof Error ? failure.message : failure));
    } finally {
      if (action.current === controller) {
        action.current = undefined;
        setPending(false);
      }
    }
  }

  return (
    <aside
      className="gyro-change-origin"
      aria-label="Change origin"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2 ref={heading} tabIndex={-1}>
          <MessageSquare aria-hidden="true" size={14} /> Change origin
        </h2>
        <IconButton
          label="Close change origin"
          size="xs"
          variant="ghost"
          onClick={onClose}
        >
          <X />
        </IconButton>
      </header>
      <div className="gyro-change-origin-body" aria-busy={!history}>
        <div className="gyro-change-origin-scope" title={path}>
          <FileCode2 aria-hidden="true" size={14} /> <code>{path}</code>
          <span aria-hidden="true">·</span>
          <span>{originHunkLabel(hunk)}</span>
        </div>
        {!result ? (
          <p role="status">Searching recent chats…</p>
        ) : result.kind === "matched" || result.kind === "earlier" ? (
          <OriginDetails
            result={result}
            pending={pending}
            onOpenChat={openChat}
          />
        ) : result.kind === "ambiguous" ? (
          <div role="status">
            <h3>Multiple recorded turns match</h3>
            <p>Gyro found more than one recorded turn for this change.</p>
          </div>
        ) : (
          <div role="status">
            <h3>
              {history?.failed
                ? "Could not search all chats"
                : "No matching chat found"}
            </h3>
            {!history?.failed ? (
              <p>
                Gyro found no matching patch in the chat history it searched.
              </p>
            ) : null}
          </div>
        )}
        {history?.limited || history?.failed ? (
          <p className="gyro-change-origin-search-note">
            {history.failed
              ? "Some chat history was unavailable."
              : "Search covers recent chat history."}
          </p>
        ) : null}
        {history?.failed ? (
          <Button size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </aside>
  );
}

function OriginDetails({
  result,
  pending,
  onOpenChat,
}: {
  result: Extract<Result, { source: OriginSource }>;
  pending: boolean;
  onOpenChat: (source: OriginSource, draft: boolean) => Promise<void>;
}) {
  const { source } = result;
  const earlier = result.kind === "earlier";
  const time = new Date(source.date);
  const date = Number.isNaN(time.getTime())
    ? undefined
    : time.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
  return (
    <>
      <div
        className={`gyro-change-origin-status${earlier ? " is-earlier" : ""}`}
      >
        {earlier ? (
          <History size={13} aria-hidden="true" />
        ) : (
          <Check size={13} aria-hidden="true" />
        )}
        {earlier ? "Earlier edit at these lines" : "Matches recorded diff"}
      </div>
      <h3>{source.title}</h3>
      {source.model || date ? (
        <p className="gyro-change-origin-byline">
          {[source.model, date].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {earlier ? (
        <p>
          These lines differ from the captured edit. Open the chat to review the
          recorded change.
        </p>
      ) : null}
      <div className="gyro-change-origin-actions">
        <Button
          size="sm"
          variant="prominent"
          disabled={pending}
          trailing={<ArrowUpRight />}
          onClick={() => void onOpenChat(source, false)}
        >
          Open chat
        </Button>
        {!earlier ? (
          <Button
            size="sm"
            variant="outline"
            loading={pending}
            leading={<MessageSquare />}
            onClick={() => void onOpenChat(source, true)}
          >
            Ask about this
          </Button>
        ) : null}
      </div>
      {source.request?.trim() ? (
        <section>
          <h4>Original request</h4>
          <blockquote>
            {source.request.length > 500
              ? `${source.request.slice(0, 500).trimEnd()}…`
              : source.request}
          </blockquote>
        </section>
      ) : null}
      <section>
        <h4>{earlier ? "Recorded change" : "What changed"}</h4>
        <p>
          {source.hunk.additions}{" "}
          {source.hunk.additions === 1 ? "line" : "lines"} added and{" "}
          {source.hunk.deletions} removed.
        </p>
      </section>
      {source.fileNote ? (
        <section>
          <h4>Agent’s file note</h4>
          <p>
            {source.fileNote.length > 320
              ? `${source.fileNote.slice(0, 320).trimEnd()}…`
              : source.fileNote}
          </p>
        </section>
      ) : null}
      <section>
        <h4>Checks from this turn</h4>
        {source.checks.length ? (
          <ul>
            {source.checks.map(({ label, status }, index) => (
              <li key={index}>
                <code>{label}</code>
                <span data-test-result={status}>{status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No test results recorded for this turn.</p>
        )}
      </section>
    </>
  );
}
