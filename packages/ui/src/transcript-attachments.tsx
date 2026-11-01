import { RotateCcw, SquareTerminal } from "lucide-react";
import { ChatFileCard, chatFileKind } from "./chat-file-card";
import { useTerminalAttachmentActions } from "./terminal-attachment-actions";
import type { ChatAttachment } from "./types";

/** Sent media, documents, and terminal receipts share one attachment list. */
export function TranscriptAttachmentsView({
  payload,
  formatSize,
}: {
  payload: Record<string, unknown>;
  formatSize: (bytes: number) => string;
}) {
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.filter((item): item is ChatAttachment => {
        const record =
          item && typeof item === "object"
            ? (item as Partial<ChatAttachment>)
            : undefined;
        return (
          typeof record?.id === "string" &&
          typeof record.name === "string" &&
          typeof record.kind === "string" &&
          typeof record.path === "string"
        );
      })
    : [];
  const terminalAttachmentActions = useTerminalAttachmentActions();
  if (!attachments.length) return null;
  return (
    <div className="gyro-transcript-attachments" aria-label="Attachments">
      {attachments.map((attachment) =>
        attachment.kind === "terminal-output" ? (
          <div
            className="gyro-transcript-attachment is-terminal-output"
            key={attachment.id}
          >
            <SquareTerminal size={14} />
            <span title={`${attachment.name} · ${formatSize(attachment.size)}`}>
              <strong>{attachment.name}</strong>
              <small className="gyro-attachment-size">
                {formatSize(attachment.size)}
              </small>
            </span>
            {terminalAttachmentActions?.canRerun(attachment.id) ? (
              <button
                aria-label={`Re-run the command from ${attachment.name}`}
                className="gyro-transcript-attachment-rerun"
                onClick={() => terminalAttachmentActions.rerun(attachment.id)}
                title="Run the command again to check the fix"
                type="button"
              >
                <RotateCcw size={12} />
                <span>Re-run</span>
              </button>
            ) : null}
          </div>
        ) : (
          <ChatFileCard
            key={attachment.id}
            file={{
              target: attachment.path,
              name: attachment.name,
              kind: chatFileKind(attachment.name, attachment.mimeType),
              local: true,
            }}
            previewUrl={attachment.previewUrl}
            variant="thumbnail"
            detail={
              attachment.available === false
                ? "File no longer available"
                : formatSize(attachment.size)
            }
          />
        ),
      )}
    </div>
  );
}
