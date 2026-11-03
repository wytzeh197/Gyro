import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogDismiss } from "./use-dialog-dismiss";
import type { CloudServicesActions } from "./cloud-services-settings";
import "./cloud-chat-backup.css";

export type ChatBackupReview = {
  localId: string;
  available: boolean;
  uploading?: boolean;
  accountKey: string;
  request: CloudServicesActions["request"];
};

type ReviewState =
  | { status: "loading" }
  | { status: "ready"; ticket: string; content: Record<string, unknown> }
  | { status: "uploaded" | "unchanged" | "queued" | "unconfirmed" }
  | { status: "error"; message: string };

export function CloudChatBackup({
  localId,
  request,
  available,
  uploading: backgroundUpload = false,
  onUploadStateChange,
  onDismiss,
}: ChatBackupReview & {
  onUploadStateChange?: (uploading: boolean) => void;
  onDismiss: () => void;
}) {
  const titleId = useId();
  const { ref: dialogRef, dismiss } = useDialogDismiss(onDismiss);
  const requestRef = useRef(request);
  const availableRef = useRef(available);
  const [state, setState] = useState<ReviewState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadInFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    requestRef.current = request;
    availableRef.current = available;
  }, [request, available]);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!availableRef.current) {
      setState({
        status: "error",
        message: "Chat backup requires an available Gyro Cloud connection.",
      });
      return;
    }
    setReviewed(false);
    setState({ status: "loading" });
    // A preview is local. The user must confirm before a ticket can upload.
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      try {
        const result = await requestRef.current({
          operation: "preview-chat",
          localId,
        });
        if (cancelled) return;
        if (
          result.kind !== "chat" ||
          typeof result.ticket !== "string" ||
          !result.content ||
          typeof result.content !== "object" ||
          Array.isArray(result.content)
        ) {
          throw new Error("Gyro could not read this chat preview.");
        }
        setState({
          status: "ready",
          ticket: result.ticket,
          content: result.content as Record<string, unknown>,
        });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: String(error) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [localId, revision]);

  const upload = async () => {
    if (
      !available ||
      backgroundUpload ||
      !reviewed ||
      state.status !== "ready" ||
      uploadInFlight.current
    )
      return;
    uploadInFlight.current = true;
    setUploading(true);
    onUploadStateChange?.(true);
    try {
      const result = await requestRef.current({
        operation: "upload-preview",
        ticket: state.ticket,
        reviewed: true,
      });
      setState({
        status:
          result.queued === true
            ? "queued"
            : result.uploaded
              ? typeof result.uploaded === "object" &&
                "unchanged" in result.uploaded &&
                result.uploaded.unchanged === true
                ? "unchanged"
                : "uploaded"
              : "unconfirmed",
      });
    } catch {
      // A consumed preview cannot be reused and an ambiguous upload isn't retried here.
      setState({ status: "unconfirmed" });
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
      onUploadStateChange?.(false);
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      className="gyro-project-remove-overlay"
      aria-modal="true"
      aria-labelledby={titleId}
      role="dialog"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <section className="gyro-project-remove-card gyro-cloud-backup-review">
        <h2 id={titleId} ref={heading} tabIndex={-1}>
          Back up this chat
        </h2>
        {state.status === "loading" ? (
          <p role="status">
            {available
              ? "Preparing the chat preview…"
              : "Chat backup requires an available Gyro Cloud connection."}
          </p>
        ) : null}
        {state.status === "error" ? (
          <>
            <p role="alert">{state.message}</p>
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={!available}
              onClick={() => setRevision((value) => value + 1)}
            >
              Try preview again
            </button>
          </>
        ) : null}
        {state.status === "ready" ? (
          <>
            {typeof state.content.title === "string" ? (
              <strong>{state.content.title}</strong>
            ) : null}
            <p>
              Review the exact content before sending it to Gyro Cloud.
              Attachments and tool actions are excluded.
            </p>
            <div
              className="gyro-cloud-backup-payload"
              tabIndex={0}
              aria-label="Chat messages to back up"
            >
              {Array.isArray(state.content.messages)
                ? state.content.messages.map((message, index) => {
                    if (!message || typeof message.text !== "string")
                      return null;
                    return (
                      <div key={index} className="gyro-cloud-backup-message">
                        <strong>
                          {message.role === "user"
                            ? "You"
                            : message.role === "assistant"
                              ? "Assistant"
                              : String(message.role ?? "Message")}
                        </strong>
                        <p>{message.text}</p>
                      </div>
                    );
                  })
                : null}
            </div>
            <details className="gyro-cloud-backup-details">
              <summary>View exact upload data</summary>
              <pre className="gyro-cloud-backup-payload" tabIndex={0}>
                {JSON.stringify(state.content, null, 2)}
              </pre>
            </details>
            <label>
              <input
                type="checkbox"
                checked={reviewed}
                disabled={uploading || backgroundUpload}
                onChange={(event) => setReviewed(event.currentTarget.checked)}
              />{" "}
              I reviewed what will be uploaded
            </label>
            <button
              type="button"
              className="gyro-primary-button"
              disabled={
                !available || !reviewed || uploading || backgroundUpload
              }
              onClick={() => void upload()}
            >
              {uploading || backgroundUpload ? "Backing up…" : "Back up chat"}
            </button>
          </>
        ) : null}
        {state.status === "uploaded" ? (
          <p role="status">
            Chat backed up to Gyro Cloud. Your local copy is still available.
          </p>
        ) : null}
        {state.status === "unchanged" ? (
          <p role="status">This chat backup is already up to date.</p>
        ) : null}
        {state.status === "queued" ? (
          <p role="status">
            Backup queued on this Mac. Open Cloud to retry queued uploads.
          </p>
        ) : null}
        {state.status === "unconfirmed" ? (
          <p role="alert">
            Gyro could not confirm the backup. Check your saved chats and queued
            uploads in Cloud before trying again.
          </p>
        ) : null}
        <button
          type="button"
          className="gyro-secondary-button"
          onClick={dismiss}
        >
          Close
        </button>
      </section>
    </div>,
    document.body,
  );
}
