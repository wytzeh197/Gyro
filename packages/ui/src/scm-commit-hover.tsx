import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { SourceControlState } from "./types";

type Commit = NonNullable<SourceControlState["history"]>[number];

/** Portaled so the history scroller never clips the commit's details. */
export function ScmCommitHover({
  commit,
  color,
  className,
  style,
  children,
}: {
  commit: Commit;
  color: string;
  className: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const cancel = () => clearTimeout(timer.current);
  const close = () => {
    cancel();
    setOpen(false);
  };
  const enter = () => {
    cancel();
    timer.current = setTimeout(() => setOpen(true), 140);
  };
  const leave = () => {
    cancel();
    timer.current = setTimeout(() => setOpen(false), 160);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !card.current) return;
    const row = anchor.current.getBoundingClientRect();
    const edge =
      anchor.current.closest(".gyro-scm-history-list")?.getBoundingClientRect()
        .right ?? row.right;
    const bounds = card.current.getBoundingClientRect();
    const left =
      edge + 10 + bounds.width <= window.innerWidth - 12
        ? edge + 10
        : Math.max(12, row.left - bounds.width - 10);
    setPosition({
      left: Math.min(left, Math.max(12, window.innerWidth - bounds.width - 12)),
      top: Math.max(
        12,
        Math.min(row.top - 8, window.innerHeight - bounds.height - 12),
      ),
    });
    const dismiss = () => {
      clearTimeout(timer.current);
      setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (!card.current?.contains(event.target as Node)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, commit]);

  return (
    <div
      ref={anchor}
      className={className}
      style={style}
      tabIndex={0}
      aria-label={commit.subject}
      aria-describedby={open ? id : undefined}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={() => {
        cancel();
        setOpen(true);
      }}
      onBlur={close}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={card}
            id={id}
            role="tooltip"
            className="gyro-scm-commit-card"
            style={
              { ...position, "--gyro-commit-color": color } as CSSProperties
            }
            onMouseEnter={cancel}
            onMouseLeave={leave}
          >
            <div className="gyro-scm-commit-card-kind">
              <span aria-hidden="true" />
              {(commit.parents?.length ?? 0) > 1 ? "Merge commit" : "Commit"}
              <code>{commit.shortHash}</code>
            </div>
            <strong className="gyro-scm-commit-card-subject">
              {commit.subject}
            </strong>
            <div className="gyro-scm-commit-card-author">
              <span>{commit.author}</span>
              <span>{commit.relativeDate}</span>
            </div>
            {commit.refs && (
              <div className="gyro-scm-commit-card-refs">
                {commit.refs
                  .split(",")
                  .map((ref) => ref.trim())
                  .filter(Boolean)
                  .map((ref) => (
                    <span key={ref}>{ref}</span>
                  ))}
              </div>
            )}
            <dl className="gyro-scm-commit-card-details">
              <dt>Commit</dt>
              <dd>{commit.hash}</dd>
              {Boolean(commit.parents?.length) && (
                <>
                  <dt>{commit.parents!.length > 1 ? "Parents" : "Parent"}</dt>
                  <dd>
                    {commit
                      .parents!.map((hash) => hash.slice(0, 8))
                      .join(" · ")}
                  </dd>
                </>
              )}
            </dl>
          </div>,
          document.body,
        )}
    </div>
  );
}
