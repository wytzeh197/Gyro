import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X, Send } from "lucide-react";
import type {
  BrowserAnnotationCapture,
  BrowserElementAnnotation,
  BrowserFeedback,
  BrowserScreenshotHandler,
} from "./types";

/** Prefer upper-right, then left/below; clamp even when the panel is narrow. */
export function placeAnnotationBubble(
  stage: { width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
  bubble: { width: number; height: number },
) {
  const gap = 8;
  const choices = [
    { x: target.x + target.width + gap, y: target.y },
    { x: target.x - bubble.width - gap, y: target.y },
    {
      x: target.x + target.width - bubble.width,
      y: target.y + target.height + gap,
    },
    { x: target.x, y: target.y - bubble.height - gap },
  ];
  const visible = (p: { x: number; y: number }) =>
    Math.max(
      0,
      Math.min(stage.width - gap, p.x + bubble.width) - Math.max(gap, p.x),
    ) *
    Math.max(
      0,
      Math.min(stage.height - gap, p.y + bubble.height) - Math.max(gap, p.y),
    );
  const best = choices.reduce((a, b) => (visible(b) > visible(a) ? b : a));
  return {
    left: Math.max(gap, Math.min(best.x, stage.width - bubble.width - gap)),
    top: Math.max(gap, Math.min(best.y, stage.height - bubble.height - gap)),
  };
}

export function BrowserAnnotationControls({
  onAction,
  onClose,
  initialAnnotation,
  inline = false,
  portalTarget,
  onCaptureReady,
}: {
  onAction: BrowserScreenshotHandler;
  onClose: () => void;
  initialAnnotation?: BrowserElementAnnotation;
  inline?: boolean;
  portalTarget?: RefObject<HTMLDivElement>;
  onCaptureReady?: (ready: boolean) => void;
}) {
  const [annotation, setAnnotation] = useState(initialAnnotation);
  const [capture, setCapture] = useState<BrowserAnnotationCapture>();
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [selecting, setSelecting] = useState(!initialAnnotation);
  const action = useRef(onAction).current;
  const close = useRef(onClose).current;
  const captureReady = useRef(onCaptureReady).current;
  const tokenRef = useRef("");
  const alive = useRef(true);
  const submitting = useRef(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const payload = (): BrowserFeedback => ({
    captureId: "",
    comment: "",
    region: { x: 0, y: 0, width: 0, height: 0 },
    annotationToken: tokenRef.current,
  });

  useEffect(() => {
    alive.current = true;
    const token = crypto.randomUUID();
    tokenRef.current = token;
    const selectionPayload = (): BrowserFeedback => ({
      ...payload(),
      annotationToken: token,
    });
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const selected = async (value: BrowserElementAnnotation) => {
      setAnnotation(value);
      setSelecting(false);
      if (!inline) return;
      setCapturing(true);
      try {
        const result = await action("annotate-capture", {
          ...payload(),
          annotation: value,
        });
        if (disposed) return;
        if (!result || typeof result !== "object" || !result.capture)
          throw new Error(
            result && typeof result === "object"
              ? result.error || "Capture failed. Select again."
              : "Capture failed. Select again.",
          );
        setCapture(result.capture);
        captureReady?.(true);
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        if (!disposed) setCapturing(false);
      }
    };
    const request = async (start: boolean) => {
      try {
        const result = await action(
          start ? "annotate-start" : "annotate-read",
          selectionPayload(),
        );
        if (disposed) return;
        if (!result || typeof result !== "object")
          throw new Error("Element selection is unavailable.");
        if (result.error) setError(result.error);
        if (result.annotation) {
          await selected(result.annotation);
          return;
        }
        if (!result.active) {
          setSelecting(false);
          if (!result.error) close();
          return;
        }
        timer = setTimeout(() => void request(false), 100);
      } catch (cause) {
        if (!disposed) {
          setError(String(cause));
          setSelecting(false);
        }
      }
    };
    if (initialAnnotation) void selected(initialAnnotation);
    else void request(true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting.current) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      disposed = true;
      alive.current = false;
      clearTimeout(timer);
      window.removeEventListener("keydown", escape);
      captureReady?.(false);
      void Promise.resolve(action("annotate-stop", selectionPayload())).catch(
        () => {},
      );
    };
  }, [action, close, initialAnnotation, inline, captureReady]);

  useEffect(() => {
    if ((!inline && annotation) || capture) commentRef.current?.focus();
  }, [annotation, capture, inline]);
  useLayoutEffect(() => {
    const stage = stageRef.current,
      form = formRef.current;
    if (!capture || !stage || !form) return;
    const measure = () => {
      const s = stage.getBoundingClientRect(),
        b = form.getBoundingClientRect();
      const viewport = capture.annotation.viewport;
      const scale = Math.min(
        s.width / viewport.width,
        s.height / viewport.height,
      );
      const r = capture.annotation.rect;
      const next = placeAnnotationBubble(
        s,
        {
          x: (s.width - viewport.width * scale) / 2 + r.x * scale,
          y: r.y * scale,
          width: r.width * scale,
          height: r.height * scale,
        },
        b,
      );
      setPosition((old) =>
        old.left === next.left && old.top === next.top ? old : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(form);
    measure();
    return () => observer.disconnect();
  }, [capture, error]);

  const form = (
    <form
      ref={formRef}
      className={
        "gyro-browser-feedback-form gyro-browser-annotation-form" +
        (capture ? " is-bubble" : "")
      }
      style={capture ? position : undefined}
      aria-label="Element annotation"
      aria-busy={busy || capturing}
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          !annotation ||
          !comment.trim() ||
          submitting.current ||
          capturing ||
          (inline && !capture)
        )
          return;
        submitting.current = true;
        setBusy(true);
        setError("");
        try {
          const result = await action(
            inline ? "annotate-send" : "annotate-add",
            { ...payload(), annotation, annotationCapture: capture, comment },
          );
          if (!alive.current) return;
          if (
            result === false ||
            (result && typeof result === "object" && result.error) ||
            (inline && (!result || typeof result !== "object" || !result.sent))
          )
            throw new Error(
              result && typeof result === "object"
                ? result.error || "Message was not sent. Try again."
                : "Message was not sent. Try again.",
            );
          close();
        } catch (cause) {
          if (alive.current) setError(String(cause));
        } finally {
          submitting.current = false;
          if (alive.current) setBusy(false);
        }
      }}
    >
      <div className="gyro-annotation-heading">
        <span role="status">
          {capturing
            ? "Capturing selection…"
            : selecting
              ? "Hover to select · ↑ parent / ↓ child · Esc to cancel"
              : capture
                ? capture.annotation.outline?.exact === false
                  ? "Captured · element bounds"
                  : "Captured"
                : annotation
                  ? `Selected ${annotation.name || annotation.tag}`
                  : "Selection unavailable"}
        </span>
        <button
          type="button"
          aria-label="Close annotation"
          title="Close annotation"
          disabled={busy}
          onClick={close}
        >
          <X size={14} />
        </button>
      </div>
      {error ? <span role="alert">{error}</span> : null}
      {annotation && (!inline || capture) ? (
        <>
          {capture ? (
            <span className="gyro-annotation-target">
              {annotation.name || annotation.text || annotation.tag}
            </span>
          ) : null}
          <textarea
            ref={commentRef}
            aria-label="Element feedback"
            maxLength={1000}
            value={comment}
            disabled={busy}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What should change here?"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="gyro-annotation-footer">
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button type="submit" disabled={!comment.trim() || busy}>
              {inline ? <Send size={13} /> : null}
              {busy
                ? inline
                  ? "Sending…"
                  : "Adding…"
                : inline
                  ? "Send"
                  : "Add to chat"}
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
  if (!capture || !portalTarget?.current) return form;
  const shape = capture.annotation.outline;
  return createPortal(
    <div className="gyro-browser-annotation-stage" ref={stageRef}>
      <img
        className="gyro-annotation-backdrop"
        src={capture.backdrop}
        alt="Captured page for annotation"
      />
      {shape ? (
        <svg
          className="gyro-annotation-outline"
          viewBox={`0 0 ${capture.annotation.viewport.width} ${capture.annotation.viewport.height}`}
          preserveAspectRatio="xMidYMin meet"
          aria-hidden="true"
        >
          <path
            d={shape.path}
            strokeDasharray={shape.exact ? undefined : "5 3"}
            transform={`matrix(${shape.matrix.join(" ")})`}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
      {form}
    </div>,
    portalTarget.current,
  );
}
