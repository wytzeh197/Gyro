import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FileText, Image, Music2, Video, X } from "lucide-react";
import { workspaceFileBadge } from "./workspace-file-icons";
import {
  chatFileKind,
  chatInlineTokenPattern,
  isCitedImageTarget,
  linkedChatFile,
  parseChatMarkdownLink,
  type ChatFileLink,
} from "./chat-file-links";

export type ChatFileScope = {
  sessionId?: string;
  workspacePath?: string;
  providerId?: string;
  providerSessionId?: string;
};
export const ChatFileScopeContext = createContext<ChatFileScope | undefined>(
  undefined,
);

export const ChatFileActionsContext = createContext<
  | {
      preview: (
        path: string,
        kind: "image" | "video" | "audio",
        scope?: ChatFileScope,
      ) => Promise<string | undefined>;
      open: (path: string) => void;
      resolveCitedImage?: (request: {
        target: string;
        providerId?: string;
        providerSessionId?: string;
        scope?: ChatFileScope;
      }) => Promise<string | undefined>;
    }
  | undefined
>(undefined);

export type ChatImageHint = {
  providerId?: string;
  providerSessionId?: string;
  markdownImages?: ReadonlySet<string>;
  /** Markdown images render in a row under the reply instead of inline. */
  imagesBelow?: boolean;
};

export const ChatImageHintContext = createContext<ChatImageHint | undefined>(
  undefined,
);

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
  /**
   * Mentions are inline links; sent screenshots use a compact preview. A tile
   * is a fixed square in the image row under a reply, placeholder included.
   */
  variant?: "card" | "thumbnail" | "tile" | "inline";
}) {
  const actions = useContext(ChatFileActionsContext);
  const scope = useContext(ChatFileScopeContext);
  const hint = useContext(ChatImageHintContext);
  const trigger = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [resolvedPreview, setResolvedPreview] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [rejectedPreview, setRejectedPreview] = useState<string>();
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const suppliedPreview =
    previewUrl === rejectedPreview ? undefined : previewUrl;
  const media =
    file.kind === "image" || file.kind === "video" || file.kind === "audio";
  const src =
    suppliedPreview ??
    (file.local ? resolvedPreview : media ? file.target : undefined);
  useEffect(() => {
    let current = true;
    setFailed(false);
    setResolvedPreview(undefined);
    setPreviewPending(false);
    if (
      !suppliedPreview &&
      file.local &&
      (file.kind === "image" || file.kind === "video" || file.kind === "audio")
    ) {
      if (actions?.preview) {
        setPreviewPending(true);
        void actions
          .preview(file.target, file.kind, {
            ...scope,
            providerId: hint?.providerId,
            providerSessionId: hint?.providerSessionId,
          })
          .then((url) => {
            if (!current) return;
            setResolvedPreview(url);
            setPreviewPending(false);
          })
          .catch(() => {
            if (!current) return;
            setFailed(true);
            setPreviewPending(false);
          });
      }
    }
    return () => {
      current = false;
    };
  }, [
    file.target,
    file.kind,
    file.local,
    suppliedPreview,
    actions,
    scope?.sessionId,
    scope?.workspacePath,
    hint?.providerId,
    hint?.providerSessionId,
    previewAttempt,
  ]);
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
  const tile = variant === "tile";
  const thumbnail =
    tile ||
    (variant === "thumbnail" &&
      file.kind === "image" &&
      hasPreview &&
      detail !== "File no longer available");
  const inline = variant === "inline";
  const inlineName = inline
    ? (file.local
        ? file.target
        : decodeURIComponent(new URL(file.target).pathname)
      )
        .split("/")
        .pop() || file.name
    : file.name;
  const className = inline
    ? "gyro-chat-file-link"
    : `gyro-chat-file-card is-${file.kind}${thumbnail ? " is-thumbnail" : ""}${tile ? " is-tile" : ""}`;
  const open = () => {
    if (media && hasPreview) setExpanded(true);
    else if (file.local && file.kind === "image" && actions?.preview)
      setPreviewAttempt((attempt) => attempt + 1);
    else if (file.local) actions?.open(file.target);
    else onOpen?.(file.target);
  };
  const label =
    media && hasPreview
      ? `Preview ${inlineName}`
      : file.local && file.kind === "image" && actions?.preview
        ? `Retry preview ${inlineName}`
        : file.local
          ? `Show ${inlineName} in Finder`
          : `Open ${inlineName}`;
  const content = inline ? (
    inlineName
  ) : (
    <>
      {media &&
      file.kind !== "audio" &&
      (tile ||
        variant !== "thumbnail" ||
        file.kind !== "image" ||
        hasPreview) ? (
        <span
          className={
            hasPreview
              ? "gyro-chat-file-thumbnail"
              : "gyro-chat-file-thumbnail is-placeholder"
          }
        >
          {hasPreview && file.kind === "image" ? (
            <img
              alt=""
              loading="lazy"
              onError={() => {
                if (suppliedPreview && file.local)
                  setRejectedPreview(suppliedPreview);
                else setFailed(true);
              }}
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
            <>
              <Icon aria-hidden="true" size={22} />
              <span className="gyro-chat-file-placeholder-note">
                {previewPending ? "Loading preview…" : "Preview unavailable"}
              </span>
            </>
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

/**
 * Turn a model-cited image path into a preview card.
 * Without a resolver, or when the file is not in an allowed root, the original
 * text stays. A backtick that repeats a markdown image in the same message
 * renders nothing.
 */
export function CitedChatImage({
  target,
  alt,
  fallback,
  skipWhenMarkdownImage = false,
  variant = "card",
}: {
  target: string;
  alt?: string;
  fallback: ReactNode;
  skipWhenMarkdownImage?: boolean;
  variant?: "card" | "tile";
}) {
  const actions = useContext(ChatFileActionsContext);
  const scope = useContext(ChatFileScopeContext);
  const hint = useContext(ChatImageHintContext);
  const skipped =
    skipWhenMarkdownImage && hint?.markdownImages?.has(target.trim()) === true;
  const resolve = skipped ? undefined : actions?.resolveCitedImage;
  const [path, setPath] = useState<string>();
  const [settled, setSettled] = useState(!resolve);
  useEffect(() => {
    if (!resolve) {
      setPath(undefined);
      setSettled(true);
      return;
    }
    let current = true;
    setSettled(false);
    setPath(undefined);
    void resolve({
      target,
      providerId: hint?.providerId,
      providerSessionId: hint?.providerSessionId,
      scope,
    })
      .then((resolved) => {
        if (!current) return;
        setPath(resolved);
        setSettled(true);
      })
      .catch(() => {
        if (!current) return;
        setPath(undefined);
        setSettled(true);
      });
    return () => {
      current = false;
    };
  }, [
    resolve,
    target,
    hint?.providerId,
    hint?.providerSessionId,
    scope?.sessionId,
    scope?.workspacePath,
  ]);
  if (skipped) return null;
  if (!resolve) return <>{fallback}</>;
  if (!settled || !path) {
    return settled ? <>{fallback}</> : <span hidden />;
  }
  const name = alt?.trim() || path.split("/").pop() || "image";
  return (
    <ChatFileCard
      file={{ target: path, name, kind: "image", local: true }}
      variant={variant}
    />
  );
}

export type ReplyImage = { label: string; target: string };

/** A markdown image that belongs in the row under a reply; video stays inline. */
export function isReplyRowImage(label: string, target: string) {
  const file = linkedChatFile(label, target, true);
  return file ? file.kind === "image" : isCitedImageTarget(target);
}

function replyImageLink(part: string) {
  const link = parseChatMarkdownLink(part);
  return link?.image && isReplyRowImage(link.label, link.target)
    ? link
    : undefined;
}

/** Markdown images in reply text, in reading order and once each. */
export function replyImageLinks(texts: readonly string[]): ReplyImage[] {
  const seen = new Set<string>();
  const images: ReplyImage[] = [];
  for (const text of texts) {
    for (const part of text.split(chatInlineTokenPattern)) {
      const link = replyImageLink(part);
      const target = link?.target.trim();
      if (!link || !target || seen.has(target)) continue;
      seen.add(target);
      images.push({ label: link.label, target });
    }
  }
  return images;
}

/** Text with nothing left once its images move to the row under the reply. */
export function isOnlyReplyImages(text: string) {
  const parts = text
    .split(chatInlineTokenPattern)
    .filter((part) => part.trim());
  return parts.length > 0 && parts.every((part) => replyImageLink(part));
}

/** Hides an inline markdown image when the reply shows its images below. */
export function ReplyImageSlot({ children }: { children: ReactNode }) {
  const hint = useContext(ChatImageHintContext);
  return hint?.imagesBelow ? null : <>{children}</>;
}

/**
 * The images a reply cites, as a row of small tiles after its text. A tile
 * opens the same preview dialog as a sent screenshot.
 */
export function ReplyImages({ images }: { images: readonly ReplyImage[] }) {
  if (images.length === 0) return null;
  return (
    <div
      aria-label={images.length === 1 ? "Image" : `${images.length} images`}
      className="gyro-reply-images"
      role="group"
    >
      {images.map(({ label, target }) => {
        const file = linkedChatFile(label, target, true);
        return file ? (
          <ChatFileCard file={file} key={target} variant="tile" />
        ) : (
          <CitedChatImage
            alt={label}
            fallback={null}
            key={target}
            target={target}
            variant="tile"
          />
        );
      })}
    </div>
  );
}

export { chatFileKind };
