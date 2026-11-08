import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { BrowserFeedback, BrowserPreviewCapture } from "./types";

type BrowserScreenshotAction = "capture" | "reveal" | "feedback";

type BrowserCaptureViewProps = {
  capture: BrowserPreviewCapture;
  src: string;
  fallbackUrl: string;
  deviceLabel: string;
  isChat: boolean;
  onBackToLive: () => void;
  onScreenshot?: (
    action?: BrowserScreenshotAction,
    feedback?: BrowserFeedback,
  ) => void | boolean | Promise<boolean | void>;
};

export function BrowserCaptureView(props: BrowserCaptureViewProps) {
  // Readiness and feedback belong to these exact image bytes/capture. Remounting
  // on a source change also discards events and drafts from the previous image.
  return (
    <CaptureImageView
      key={JSON.stringify([
        props.src,
        props.capture.filename,
        props.capture.createdAt,
      ])}
      {...props}
    />
  );
}

function CaptureImageView({
  capture,
  src,
  fallbackUrl,
  deviceLabel,
  isChat,
  onBackToLive,
  onScreenshot,
}: BrowserCaptureViewProps) {
  const [imageStatus, setImageStatus] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  const imageReady = imageStatus === "ready";
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackRegion, setFeedbackRegion] = useState<
    BrowserFeedback["region"] | null
  >(null);
  const feedbackStartRef = useRef<{ x: number; y: number } | null>(null);
  const captureImageRef = useRef<HTMLImageElement | null>(null);
  const [captureBox, setCaptureBox] = useState({ width: 0, height: 0 });
  const fitWidth = Math.min(
    captureBox.width,
    (captureBox.height * capture.width) / capture.height,
  );
  const fitHeight = (fitWidth * capture.height) / capture.width;
  const fitLeft = (captureBox.width - fitWidth) / 2;
  const sourceLabel = browserPreviewLocationLabel(
    capture.sourceUrl ?? fallbackUrl,
  );
  const imageFailed = () => {
    setImageStatus("failed");
    setFeedbackMode(false);
    setFeedbackRegion(null);
    setFeedbackComment("");
    feedbackStartRef.current = null;
  };

  useEffect(() => {
    const image = captureImageRef.current;
    if (!image) return;
    const update = () =>
      setCaptureBox({ width: image.clientWidth, height: image.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(image);
    return () => observer.disconnect();
  }, [src]);

  const capturePoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!imageReady) return null;
    const rect = captureImageRef.current?.getBoundingClientRect();
    if (!rect || !fitWidth || !fitHeight) return null;
    const x = (event.clientX - rect.left - fitLeft) / fitWidth;
    const y = (event.clientY - rect.top) / fitHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };
  const selectFeedbackRegion = (
    start: { x: number; y: number },
    end: { x: number; y: number },
  ) => {
    const x = Math.min(0.99, Math.min(start.x, end.x));
    const y = Math.min(0.99, Math.min(start.y, end.y));
    return {
      x,
      y,
      width: Math.min(1 - x, Math.max(0.01, Math.abs(start.x - end.x))),
      height: Math.min(1 - y, Math.max(0.01, Math.abs(start.y - end.y))),
    };
  };

  return (
    <div className="gyro-browser-capture-view" data-image-state={imageStatus}>
      <div className="gyro-browser-capture-stage">
        <img
          alt={`Browser capture of ${sourceLabel || capture.sourceUrl || fallbackUrl}`}
          className="gyro-browser-capture-image"
          draggable={false}
          aria-hidden={!imageReady || undefined}
          onLoad={(event) => {
            if (
              event.currentTarget.naturalWidth > 0 &&
              event.currentTarget.naturalHeight > 0
            )
              setImageStatus("ready");
            else imageFailed();
          }}
          onError={imageFailed}
          ref={captureImageRef}
          src={src}
        />
        {!imageReady ? (
          <div
            className="gyro-browser-capture-state gyro-browser-placeholder has-capture"
            role={imageStatus === "failed" ? "alert" : "status"}
          >
            <div className="gyro-browser-placeholder-body">
              {imageStatus === "loading" ? (
                <span
                  aria-hidden="true"
                  className="gyro-ring is-running gyro-browser-loading-mark"
                />
              ) : null}
              <strong>
                {imageStatus === "failed"
                  ? "Screenshot unavailable"
                  : "Loading screenshot"}
              </strong>
              <p>
                {imageStatus === "failed"
                  ? onScreenshot
                    ? "This image could not be loaded. Take a new screenshot or return to the live page."
                    : "This image could not be loaded. Return to the live page to continue."
                  : "Loading the captured image…"}
              </p>
              {imageStatus === "failed" && onScreenshot ? (
                <div className="gyro-browser-placeholder-actions">
                  <button
                    onClick={() => {
                      void onScreenshot("capture");
                    }}
                    type="button"
                  >
                    Take new screenshot
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {feedbackMode && imageReady ? (
          <div
            aria-label="Select an area of the browser capture"
            className="gyro-browser-feedback-layer"
            onPointerDown={(event) => {
              const point = capturePoint(event);
              if (!point) return;
              feedbackStartRef.current = point;
              setFeedbackRegion(selectFeedbackRegion(point, point));
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!feedbackStartRef.current) return;
              const point = capturePoint(event);
              if (point) {
                setFeedbackRegion(
                  selectFeedbackRegion(feedbackStartRef.current, point),
                );
              }
            }}
            onPointerUp={(event) => {
              const point = capturePoint(event);
              if (point && feedbackStartRef.current) {
                setFeedbackRegion(
                  selectFeedbackRegion(feedbackStartRef.current, point),
                );
              }
              feedbackStartRef.current = null;
            }}
            role="region"
          >
            {feedbackRegion ? (
              <div
                className="gyro-browser-feedback-selection"
                style={{
                  left: fitLeft + feedbackRegion.x * fitWidth,
                  top: feedbackRegion.y * fitHeight,
                  width: feedbackRegion.width * fitWidth,
                  height: feedbackRegion.height * fitHeight,
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {feedbackMode && imageReady ? (
        <form
          className="gyro-browser-feedback-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!imageReady || !feedbackRegion || !feedbackComment.trim())
              return;
            const accepted = await onScreenshot?.("feedback", {
              captureId: capture.filename,
              comment: feedbackComment.trim(),
              region: feedbackRegion,
            });
            if (accepted !== false) setFeedbackMode(false);
          }}
        >
          <span>Select an area, then describe what should change.</span>
          <textarea
            aria-label="Browser feedback"
            maxLength={1000}
            onChange={(event) => setFeedbackComment(event.target.value)}
            placeholder="What should change here?"
            value={feedbackComment}
          />
          <div>
            <button
              disabled={!feedbackRegion || !feedbackComment.trim()}
              type="submit"
            >
              Add to chat
            </button>
            <button
              onClick={() => {
                setFeedbackMode(false);
                setFeedbackRegion(null);
                setFeedbackComment("");
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="gyro-browser-capture-meta">
        <span>
          {capture.width} × {capture.height}
          {sourceLabel ? ` · ${sourceLabel}` : ""}
          {capture.createdAt
            ? ` · ${formatBrowserCaptureTime(capture.createdAt)}`
            : ""}
        </span>
        <div className="gyro-browser-capture-actions">
          <button onClick={onBackToLive} type="button">
            Back to live
          </button>
          {isChat && onScreenshot ? (
            <button
              aria-pressed={feedbackMode}
              disabled={!imageReady}
              onClick={() => {
                if (!imageReady) return;
                setFeedbackMode((current) => !current);
                setFeedbackRegion(null);
                setFeedbackComment("");
              }}
              type="button"
            >
              Comment on page
            </button>
          ) : null}
          <button onClick={() => onScreenshot?.("reveal")} type="button">
            Reveal file
          </button>
        </div>
      </div>
    </div>
  );
}

export function browserPreviewLocationLabel(url?: string) {
  const trimmed = url?.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "";
  }
}

function formatBrowserCaptureTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}
