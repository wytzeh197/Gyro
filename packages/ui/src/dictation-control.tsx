import { Mic, Square, X } from "./icons";
import { Spinner } from "./primitives/feedback";
import { useEffect, useId, useRef } from "react";

export function DictationControl({
  phase,
  notice,
  onToggle,
  onDismissNotice,
}: {
  phase: "idle" | "starting" | "listening" | "processing";
  notice: string;
  onToggle: () => void;
  onDismissNotice: () => void;
}) {
  const noticeId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const quiet = notice === "No speech was heard.";
  const busy = phase === "starting" || phase === "processing";
  const listening = phase === "listening";
  const label =
    phase === "starting"
      ? "Cancel microphone start"
      : listening
        ? "Stop dictation"
        : phase === "processing"
          ? "Finishing dictation"
          : "Dictate";
  const status =
    phase === "starting"
      ? "Starting microphone…"
      : listening
        ? "Listening. Select Stop dictation to finish."
        : phase === "processing"
          ? "Finishing dictation…"
          : "";

  useEffect(() => {
    if (!quiet) return;
    const timeout = window.setTimeout(onDismissNotice, 5000);
    return () => window.clearTimeout(timeout);
  }, [quiet, onDismissNotice]);

  useEffect(() => {
    if (!notice) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismissNotice();
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [notice, onDismissNotice]);

  return (
    <div className="gyro-dictation-control">
      <button
        ref={buttonRef}
        aria-label={label}
        aria-describedby={notice ? noticeId : undefined}
        aria-pressed={phase === "starting" || listening}
        aria-busy={busy}
        disabled={phase === "processing"}
        className={`gyro-composer-tool gyro-dictation-button${listening ? " is-listening" : ""}${busy ? " is-processing" : ""}`}
        data-dictation-phase={phase}
        onClick={onToggle}
        title={label}
        type="button"
      >
        {busy ? (
          <Spinner decorative size="md" />
        ) : listening ? (
          <Square aria-hidden="true" fill="currentColor" size={13} />
        ) : (
          <Mic aria-hidden="true" size={18} />
        )}
        {listening ? (
          <span className="gyro-dictation-label">Listening</span>
        ) : null}
      </button>
      <span className="gyro-sr-only" role="status" aria-live="polite">
        {status}
      </span>
      {notice ? (
        <div className="gyro-dictation-feedback">
          <p id={noticeId} role="status" aria-live="polite">
            {quiet ? "No speech detected. Try again." : notice}
          </p>
          <button
            aria-label="Dismiss microphone message"
            title="Dismiss microphone message"
            type="button"
            onClick={() => {
              onDismissNotice();
              buttonRef.current?.focus();
            }}
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
