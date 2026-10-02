import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { File, FileText, Image, Music2, Video, X } from "lucide-react";
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
}: {
  file: ChatFileLink;
  previewUrl?: string;
  detail?: string;
  onOpen?: (target: string) => void;
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
  const Icon = {
    image: Image,
    video: Video,
    audio: Music2,
    pdf: FileText,
    file: File,
  }[file.kind];
  const hasPreview = Boolean(src && !failed);
  const open = () => {
    if (media && hasPreview) setExpanded(true);
    else if (file.local) actions?.open(file.target);
    else onOpen?.(file.target);
  };
  const label =
    media && hasPreview
      ? `Preview ${file.name}`
      : file.local
        ? `Show ${file.name} in Finder`
        : `Open ${file.name}`;
  const content = (
    <>
      {media && file.kind !== "audio" ? (
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
        <Icon aria-hidden="true" size={18} />
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
          className={`gyro-chat-file-card is-${file.kind}`}
          onClick={open}
          title={file.name}
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
          className={`gyro-chat-file-card is-${file.kind}`}
          href={file.target}
          rel="noreferrer"
          target="_blank"
          title={file.name}
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
