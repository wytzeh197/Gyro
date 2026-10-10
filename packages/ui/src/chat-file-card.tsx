import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Image, Music2, Video, X } from "lucide-react";
import { workspaceFileBadge } from "./workspace-file-icons";
import { chatFileKind, type ChatFileLink } from "./chat-file-links";
import "./chat-file-card.css";

export const ChatFileActionsContext = createContext<
  | {
      preview: (
        path: string,
        kind: "image" | "video" | "audio",
      ) => Promise<string | undefined>;
      open: (path: string) => void;
    }
  | undefined
>(undefined);

export function ChatFileCard({
  file,
  previewUrl,
  detail,
  onOpen,
  variant = "card",
}: {
  file: ChatFileLink;
  previewUrl?: string;
  detail?: string;
  onOpen?: (target: string) => void;
  /** Mentions are inline links; sent screenshots use a compact preview. */
  variant?: "card" | "thumbnail" | "inline";
}) {
  const actions = useContext(ChatFileActionsContext);
  const trigger = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [resolvedPreview, setResolvedPreview] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const media =
    file.kind === "image" || file.kind === "video" || file.kind === "audio";
  const src =
    previewUrl ??
    (file.local ? resolvedPreview : media ? file.target : undefined);
  useEffect(() => {
    let current = true;
    setFailed(false);
    setResolvedPreview(undefined);
    if (
      !previewUrl &&
      file.local &&
      (file.kind === "image" || file.kind === "video" || file.kind === "audio")
    ) {
      void actions
        ?.preview(file.target, file.kind)
        .then((url) => {
          if (current) setResolvedPreview(url);
        })
        .catch(() => {
          if (current) setFailed(true);
        });
    }
    return () => {
      current = false;
    };
  }, [file.target, file.kind, file.local, previewUrl, actions]);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      if (event.key === "Tab") {
        const targets = dialog.current?.querySelectorAll<HTMLElement>(
          "button, video[controls], audio[controls]",
        );
        const first = targets?.[0];
        const last = targets?.[targets.length - 1];
        if (
          first &&
          last &&
          event.shiftKey &&
          document.activeElement === first
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          first &&
          last &&
          !event.shiftKey &&
          document.activeElement === last
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss);
      trigger.current?.focus();
    };
  }, [expanded]);
  const badge = workspaceFileBadge(file.name);
  const Icon = {
    image: Image,
    video: Video,
    audio: Music2,
    pdf: FileText,
    file: badge.icon,
  }[file.kind];
  const hasPreview = Boolean(src && !failed);
  const thumbnail =
    variant === "thumbnail" &&
    file.kind === "image" &&
    hasPreview &&
    detail !== "File no longer available";
  const inline = variant === "inline";
  const inlineName = inline
    ? (file.local
        ? file.target
        : decodeURIComponent(new URL(file.target).pathname)
      ).split("/").pop() || file.name
    : file.name;
  const className = inline
    ? "gyro-chat-file-link"
    : `gyro-chat-file-card is-${file.kind}${thumbnail ? " is-thumbnail" : ""}`;
  const open = () => {
    if (media && hasPreview) setExpanded(true);
    else if (file.local) actions?.open(file.target);
    else onOpen?.(file.target);
  };
  const label =
    media && hasPreview
      ? `Preview ${inlineName}`
      : file.local
        ? `Show ${inlineName} in Finder`
        : `Open ${inlineName}`;
  const content = inline ? inlineName : (
    <>
      {media &&
      file.kind !== "audio" &&
      (variant !== "thumbnail" || file.kind !== "image" || hasPreview) ? (
        <span className="gyro-chat-file-thumbnail">
          {hasPreview && file.kind === "image" ? (
            <img
              alt=""
              loading="lazy"
              onError={() => setFailed(true)}
              src={src}
            />
          ) : hasPreview ? (
            <video
              aria-hidden="true"
              muted
              playsInline
              preload="metadata"
              onError={() => setFailed(true)}
              src={src}
            />
          ) : (
            <Icon aria-hidden="true" size={32} />
          )}
        </span>
      ) : null}
      <span className="gyro-chat-file-caption">
        <Icon
          aria-hidden="true"
          className={file.kind === "file" ? "gyro-file-identity" : undefined}
          data-file-tone={file.kind === "file" ? badge.tone : undefined}
          size={18}
        />
        <span>
          <strong>{file.name}</strong>
          {detail ? <small>{detail}</small> : null}
        </span>
      </span>
    </>
  );
  return (
    <>
      {file.local || onOpen || (media && hasPreview) ? (
        <button
          aria-label={label}
          ref={(node) => {
            trigger.current = node;
          }}
          className={className}
          onClick={open}
          title={detail ? `${inlineName} · ${detail}` : inlineName}
          type="button"
        >
          {content}
        </button>
      ) : (
        <a
          aria-label={label}
          ref={(node) => {
            trigger.current = node;
          }}
          className={className}
          href={file.target}
          rel="noreferrer"
          target="_blank"
          title={detail ? `${inlineName} · ${detail}` : inlineName}
        >
          {content}
        </a>
      )}
      {expanded && src
        ? createPortal(
            <div
              aria-label={`Preview ${file.name}`}
              aria-modal="true"
              ref={dialog}
              className="gyro-chat-file-overlay"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setExpanded(false);
              }}
              role="dialog"
            >
              <figure>
                <button
                  autoFocus
                  aria-label="Close file preview"
                  onClick={() => setExpanded(false)}
                  type="button"
                >
                  <X size={20} />
                </button>
                {file.kind === "image" ? (
                  <img alt={file.name} src={src} />
                ) : file.kind === "video" ? (
                  <video
                    tabIndex={0}
                    controls
                    playsInline
                    preload="metadata"
                    src={src}
                  />
                ) : (
                  <audio tabIndex={0} controls src={src} />
                )}
                <figcaption>{file.name}</figcaption>
              </figure>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export { chatFileKind };
