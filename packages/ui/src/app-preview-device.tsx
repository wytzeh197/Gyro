import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import type {
  AppPreviewObservation,
  AppPreviewRuntime,
  AppPreviewTarget,
  PixelRegion,
  PreviewScheme,
} from "./app-preview-panel";
import { iphoneFrame } from "./iphone-preview-geometry";

type Point = { x: number; y: number };

function screenPoint(
  bounds: DOMRect,
  capture: AppPreviewObservation,
  x: number,
  y: number,
): Point {
  const { width, height } = capture.screenshot;
  return {
    x: Math.round(
      Math.max(0, Math.min(1, (x - bounds.left) / bounds.width)) * width,
    ),
    y: Math.round(
      Math.max(0, Math.min(1, (y - bounds.top) / bounds.height)) * height,
    ),
  };
}

function selection(from: Point, to: Point): PixelRegion {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

type DeviceForm = "iphone" | "ipad" | "macbook";

function deviceSurround(
  form: DeviceForm,
  width: number,
  height: number,
  phoneFrame: ReturnType<typeof iphoneFrame>,
) {
  if (form === "macbook") {
    // Keep the 14-inch display shape and reserve room for the camera above
    // the captured app, even when the app fills the available display.
    const displayAspect = 3024 / 1964;
    const notchRatio = 11 / 500;
    const displayWidth = Math.max(
      width,
      height / (1 / displayAspect - notchRatio),
    );
    const displayHeight = displayWidth / displayAspect;
    const bezel = displayWidth * (8 / 500);
    const chin = displayWidth * (20 / 500);
    const cameraHeight = displayWidth * notchRatio;
    const overhang = displayWidth * (56 / 500);
    return {
      bezel,
      chin,
      edge: displayWidth * (1.25 / 500),
      lidRadius: displayWidth * (15 / 500),
      screenRadius: displayWidth * (7 / 500),
      cameraWidth: displayWidth * (60 / 500),
      cameraHeight,
      overhang,
      topBleed: 0,
      baseHeight: displayWidth * (22 / 500),
      lidWidth: displayWidth + bezel * 2,
      lidHeight: displayHeight + bezel + chin,
      screenLeft: overhang + bezel + (displayWidth - width) / 2,
      screenTop:
        bezel + cameraHeight + (displayHeight - cameraHeight - height) / 2,
    };
  }
  const shortEdge = Math.min(width, height);
  const phone = form === "iphone";
  const phoneWidth = phoneFrame?.screenWidth ?? 66.57;
  const bezel =
    shortEdge *
    (phone ? (phoneFrame?.bezel ?? 2.64) / phoneWidth : 10.04 / 158.44);
  const edge =
    shortEdge *
    (phone ? (phoneFrame?.rail ?? 1.2) / phoneWidth : 1.15 / 158.44);
  const screenRadius =
    shortEdge *
    (phone
      ? (phoneFrame?.cornerRadius ?? phoneWidth * 0.147) / phoneWidth
      : 0.0265);
  const button = phone ? shortEdge * (0.45 / phoneWidth) : 0;
  const overhang = width <= height ? button : 0;
  const topBleed = width > height ? button : 0;
  return {
    bezel,
    edge,
    chin: bezel,
    lidRadius: screenRadius + bezel,
    screenRadius,
    cameraWidth: phone ? 0 : shortEdge * (3.4 / 158.44),
    cameraHeight: 0,
    overhang,
    topBleed,
    baseHeight: 0,
    lidWidth: width + bezel * 2,
    lidHeight: height + bezel * 2,
    screenLeft: overhang + bezel,
    screenTop: topBleed + bezel,
  };
}

/** Fit the original pixels once. Snap the origin to the host display's pixel grid. */
function DeviceFrame({
  capture,
  selecting,
  region,
  onRegion,
  onTap,
  annotation,
}: {
  capture: AppPreviewObservation;
  selecting?: boolean;
  region?: PixelRegion;
  onRegion?: (region: PixelRegion) => void;
  onTap?: (x: number, y: number) => void;
  annotation?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    hostWidth: 0,
    hostHeight: 0,
    scale: 0,
  });
  const [dragRegion, setDragRegion] = useState<PixelRegion>();
  const drag = useRef<Point | null>(null);
  const { width, height, src } = capture.screenshot;
  const form =
    capture.target.kind === "macos"
      ? "macbook"
      : capture.target.deviceFamily === "iPad"
        ? "ipad"
        : "iphone";
  const phoneFrame =
    form === "iphone" ? iphoneFrame(capture.target.deviceType) : undefined;
  const surround = deviceSurround(form, width, height, phoneFrame);
  const cutout = width < height ? phoneFrame?.cutout : undefined;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = () => {
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const surround = deviceSurround(form, width, height, phoneFrame);
      const outerWidth = surround.lidWidth + surround.overhang * 2;
      const outerHeight =
        surround.lidHeight + surround.baseHeight + surround.topBleed * 2;
      const scale = Math.max(
        0,
        Math.min(
          (rect.width - 8) / outerWidth,
          (rect.height - 8) / outerHeight,
        ),
      );
      const w = width * scale;
      const h = height * scale;
      const snap = (origin: number, offset: number) =>
        Math.round((origin + offset) * dpr) / dpr - origin;
      setBox({
        x: snap(
          rect.left,
          (rect.width - outerWidth * scale) / 2 + surround.screenLeft * scale,
        ),
        y: snap(
          rect.top,
          (rect.height - outerHeight * scale) / 2 + surround.screenTop * scale,
        ),
        width: w,
        height: h,
        hostWidth: rect.width,
        hostHeight: rect.height,
        scale,
      });
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(el);
    let resolution = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    const displayChanged = () => {
      resolution.removeEventListener("change", displayChanged);
      resolution = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      resolution.addEventListener("change", displayChanged);
      fit();
    };
    resolution.addEventListener("change", displayChanged);
    window.addEventListener("resize", fit);
    return () => {
      resize.disconnect();
      resolution.removeEventListener("change", displayChanged);
      window.removeEventListener("resize", fit);
    };
  }, [form, width, height, phoneFrame]);

  const dragPoint = (event: PointerEvent<HTMLDivElement>) =>
    screenPoint(
      event.currentTarget.getBoundingClientRect(),
      capture,
      event.clientX,
      event.clientY,
    );
  const marked = selecting ? (dragRegion ?? region) : undefined;
  const frameX = box.x + (surround.overhang - surround.screenLeft) * box.scale;
  const frameY = box.y + (surround.topBleed - surround.screenTop) * box.scale;
  const frameWidth = surround.lidWidth * box.scale;
  const frameHeight = surround.lidHeight * box.scale;
  const rightEdge = frameX + frameWidth + surround.overhang * box.scale;
  const nextToScreenWidth = box.hostWidth - rightEdge - 20;
  const nextToScreen = nextToScreenWidth >= 144;
  const bubbleWidth = Math.min(
    224,
    Math.max(0, nextToScreen ? nextToScreenWidth : box.hostWidth - 16),
  );
  const selectionTop = box.y + ((region?.y ?? 0) / height) * box.height;
  const selectionBottom =
    selectionTop + ((region?.height ?? 0) / height) * box.height;
  const bubbleX = nextToScreen
    ? rightEdge + 12
    : Math.max(
        8,
        Math.min(
          box.hostWidth - bubbleWidth - 8,
          box.x + box.width - bubbleWidth,
        ),
      );
  const bubbleY = nextToScreen ? selectionTop : selectionBottom + 12;
  return (
    <div className="gyro-preview-device-fit" ref={host}>
      {box.scale > 0 && (
        <div
          className="gyro-preview-device-shell"
          data-form={form}
          data-landscape={width > height || undefined}
          aria-hidden="true"
          style={
            {
              left: frameX,
              top: frameY,
              width: frameWidth,
              height: frameHeight,
              "--gyro-device-bezel": `${surround.bezel * box.scale}px`,
              "--gyro-device-radius": `${surround.lidRadius * box.scale}px`,
              "--gyro-device-screen-radius": `${surround.screenRadius * box.scale}px`,
              "--gyro-device-edge": `${surround.edge * box.scale}px`,
              "--gyro-device-chin": `${surround.chin * box.scale}px`,
              "--gyro-device-camera-width": `${surround.cameraWidth * box.scale}px`,
              "--gyro-device-camera-height": `${surround.cameraHeight * box.scale}px`,
              "--gyro-device-button": `${Math.max(surround.overhang, surround.topBleed) * box.scale}px`,
              "--gyro-device-overhang": `${surround.overhang * box.scale}px`,
              "--gyro-device-base": `${surround.baseHeight * box.scale}px`,
            } as CSSProperties
          }
        >
          <div className="gyro-preview-device-lid">
            <div className="gyro-preview-device-glass" />
            {form !== "iphone" && (
              <div className="gyro-preview-device-camera" />
            )}
          </div>
          {form === "iphone" && (
            <div className="gyro-preview-device-buttons">
              <i data-button="action" />
              <i data-button="volume-up" />
              <i data-button="volume-down" />
              <i data-button="side" />
            </div>
          )}
          {form === "macbook" && <div className="gyro-preview-device-base" />}
        </div>
      )}
      <div
        className="gyro-preview-device-screen"
        data-selecting={selecting || undefined}
        data-can-tap={Boolean(onTap) || undefined}
        style={{
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          borderRadius:
            form === "macbook" ? undefined : surround.screenRadius * box.scale,
        }}
        onPointerDown={(event) => {
          if (!selecting || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = dragPoint(event);
          setDragRegion(undefined);
          event.preventDefault();
        }}
        onClick={(event) => {
          if (!selecting && onTap) {
            const point = screenPoint(
              event.currentTarget.getBoundingClientRect(),
              capture,
              event.clientX,
              event.clientY,
            );
            onTap(Math.min(width - 1, point.x), Math.min(height - 1, point.y));
          }
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setDragRegion(selection(drag.current, dragPoint(event)));
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          const picked = selection(drag.current, dragPoint(event));
          drag.current = null;
          setDragRegion(undefined);
          if (picked.width > 0 && picked.height > 0) onRegion?.(picked);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragRegion(undefined);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragRegion(undefined);
        }}
      >
        <img
          src={src}
          width={width}
          height={height}
          alt={`${capture.target.title} app screen`}
          draggable={false}
        />
        {phoneFrame && cutout && (
          <div
            className="gyro-preview-device-cutout"
            data-cutout={cutout.kind}
            aria-hidden="true"
            style={{
              top: `${(100 * cutout.top) / phoneFrame.screenHeight}%`,
              width: `${(100 * cutout.width) / phoneFrame.screenWidth}%`,
              height: `${(100 * cutout.height) / phoneFrame.screenHeight}%`,
              borderRadius:
                cutout.kind === "notch"
                  ? `0 0 ${(cutout.bottomRadius / phoneFrame.screenWidth) * box.width}px ${(cutout.bottomRadius / phoneFrame.screenWidth) * box.width}px`
                  : undefined,
            }}
          />
        )}
        {marked && (
          <div
            className="gyro-preview-device-region"
            style={{
              left: `${(100 * marked.x) / width}%`,
              top: `${(100 * marked.y) / height}%`,
              width: `${(100 * marked.width) / width}%`,
              height: `${(100 * marked.height) / height}%`,
            }}
          />
        )}
      </div>
      {annotation && region && (
        <div
          className="gyro-preview-device-popover"
          style={{
            width: bubbleWidth,
            left: bubbleX,
            top: Math.max(8, Math.min(box.hostHeight - 124, bubbleY)),
          }}
        >
          {annotation}
        </div>
      )}
    </div>
  );
}

export function NativeAppPreview({
  runtime,
  target,
  targetPicker,
  capture,
  onCapture,
  onRefresh,
  busy,
  issue,
  stale,
  onSend,
}: {
  runtime: AppPreviewRuntime;
  target: AppPreviewTarget;
  targetPicker: ReactNode;
  capture?: AppPreviewObservation;
  onCapture: (capture: AppPreviewObservation) => void;
  onRefresh: () => void;
  busy: boolean;
  issue: string;
  stale: boolean;
  onSend?: (
    capture: AppPreviewObservation,
    region: PixelRegion,
    comment: string,
  ) => Promise<{ error?: string }>;
}) {
  const [schemes, setSchemes] = useState<PreviewScheme[]>([]);
  const [scheme, setScheme] = useState<PreviewScheme>();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState("");
  const [built, setBuilt] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [frame, setFrame] = useState<AppPreviewObservation>();
  const [annotationFrame, setAnnotationFrame] =
    useState<AppPreviewObservation>();
  const marked = Boolean(annotationFrame);
  const [inspecting, setInspecting] = useState(false);
  const [region, setRegion] = useState<PixelRegion>();
  const [comment, setComment] = useState("");
  const [before, setBefore] = useState<AppPreviewObservation>();
  const [comparing, setComparing] = useState(false);
  const [side, setSide] = useState<"before" | "after">("after");
  const mounted = useRef(true);
  const annotateButton = useRef<HTMLButtonElement>(null);
  const locked = busy || Boolean(pending);
  const isSimulator = target.kind === "simulator";
  const canCompare = Boolean(
    before &&
    capture &&
    before.screenshot.filename !== capture.screenshot.filename &&
    before.screenshot.width === capture.screenshot.width &&
    before.screenshot.height === capture.screenshot.height,
  );

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = runtime.subscribeBuild?.((event) => {
      if (event.targetId === target.id) setPending(event.phase);
    });
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [runtime, target.id]);

  useEffect(() => {
    if (
      !autoRefresh ||
      !runtime.simulatorFrame ||
      pending ||
      busy ||
      comparing ||
      marked
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!document.hidden) {
        try {
          const next = await runtime.simulatorFrame?.();
          if (cancelled) return;
          if (next?.target.id === target.id) setFrame(next);
        } catch (error) {
          if (cancelled) return;
          setAutoRefresh(false);
          setFrame(undefined);
          setError(String(error));
          return;
        }
      }
      if (!cancelled) timer = setTimeout(refresh, 2000);
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [autoRefresh, runtime, target.id, pending, busy, comparing, marked]);

  const fail = (error: unknown) => {
    const [message, ...log] = String(error).split("\n");
    setError(message ?? "Preview failed.");
    setDetails(log.join("\n"));
  };
  const act = async (label: string, action: () => Promise<void>) => {
    setPending(label);
    setFrame(undefined);
    setError("");
    setDetails("");
    try {
      await action();
    } catch (error) {
      if (mounted.current) fail(error);
    } finally {
      if (mounted.current) setPending("");
    }
  };
  const run = (choice: PreviewScheme) =>
    act("Building", async () => {
      if (!runtime.run) return;
      const next = await runtime.run(choice);
      if (!mounted.current) return;
      setBuilt(true);
      setComparing(false);
      onCapture(next);
    });
  const startRun = () => {
    if (scheme) {
      void run(scheme);
      return;
    }
    void act("Finding Xcode schemes", async () => {
      const choices = (await runtime.schemes?.()) ?? [];
      if (!mounted.current) return;
      if (!choices.length) throw new Error("No Xcode schemes are available.");
      setSchemes(choices);
      const onlyChoice = choices[0];
      if (choices.length === 1 && onlyChoice) {
        setScheme(onlyChoice);
        await run(onlyChoice);
      }
    });
  };
  const stopMarking = () => {
    setAnnotationFrame(undefined);
    setRegion(undefined);
    setComment("");
    annotateButton.current?.focus();
  };
  const send = () => {
    if (!annotationFrame || !region || !comment.trim() || !onSend) return;
    void act("Sending annotation", async () => {
      const result = await onSend(annotationFrame, region, comment.trim());
      if (result.error) throw new Error(result.error);
      if (!mounted.current) return;
      setBefore(annotationFrame);
      stopMarking();
    });
  };

  const annotation =
    marked && region ? (
      <form
        className="gyro-preview-device-annotation"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          autoFocus
          aria-label="App feedback"
          placeholder="What should change?"
          rows={2}
          value={comment}
          maxLength={1000}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter" &&
              !locked
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div>
          <button type="button" onClick={stopMarking} disabled={locked}>
            Cancel
          </button>
          <button type="submit" disabled={locked || !comment.trim()}>
            Send
          </button>
        </div>
      </form>
    ) : undefined;

  return (
    <div
      className="gyro-preview-device"
      onKeyDown={(event) => {
        if (event.key === "Escape" && marked && !pending) {
          event.stopPropagation();
          stopMarking();
        }
      }}
    >
      <div className="gyro-app-preview-toolbar">
        {targetPicker}
        {schemes.length > 1 && (
          <select
            aria-label="Xcode scheme"
            value={scheme ? schemes.indexOf(scheme) : ""}
            disabled={locked || marked}
            onChange={(event) => setScheme(schemes[Number(event.target.value)])}
          >
            <option value="" disabled>
              Choose scheme
            </option>
            {schemes.map((item, index) => (
              <option key={`${item.project}:${item.name}`} value={index}>
                {item.name} · {item.project}
              </option>
            ))}
          </select>
        )}
        {isSimulator && runtime.run && (
          <button
            type="button"
            onClick={startRun}
            disabled={locked || marked || (schemes.length > 1 && !scheme)}
          >
            {built ? "Rebuild" : "Run"}
          </button>
        )}
        {capture && onSend && (
          <button
            type="button"
            ref={annotateButton}
            aria-pressed={marked}
            disabled={
              locked || comparing || (stale && !marked && Boolean(issue))
            }
            onClick={() => {
              if (marked) stopMarking();
              else if (frame) {
                void act("Capturing app", async () => {
                  const snapshot = await runtime.capture();
                  if (mounted.current) {
                    onCapture(snapshot);
                    setAnnotationFrame(snapshot);
                  }
                });
              } else {
                setInspecting(false);
                setAnnotationFrame(capture);
              }
            }}
          >
            Annotate
          </button>
        )}
        {capture?.interaction === "click" && !marked && !comparing && (
          <button
            type="button"
            aria-pressed={inspecting}
            disabled={locked || stale}
            onClick={() => setInspecting((value) => !value)}
          >
            Click to inspect
          </button>
        )}
        {canCompare && !marked && (
          <button
            type="button"
            aria-pressed={comparing}
            disabled={locked}
            onClick={() => {
              setInspecting(false);
              setFrame(undefined);
              setComparing((value) => !value);
            }}
          >
            {comparing ? "Back to preview" : "Compare"}
          </button>
        )}
      </div>
      {(issue || error) && (
        <p className="gyro-app-preview-error" role="alert">
          {error || issue}
        </p>
      )}
      {details && (
        <details className="gyro-preview-device-log">
          <summary>Build log</summary>
          <pre>{details}</pre>
        </details>
      )}
      <div className="gyro-preview-device-canvas">
        {comparing && before && capture && canCompare ? (
          <div className="gyro-preview-device-comparison" data-side={side}>
            <div
              className="gyro-preview-device-toggle"
              aria-label="Comparison frame"
            >
              <button
                type="button"
                aria-pressed={side === "before"}
                onClick={() => setSide("before")}
              >
                Before
              </button>
              <button
                type="button"
                aria-pressed={side === "after"}
                onClick={() => setSide("after")}
              >
                After
              </button>
            </div>
            <figure data-frame="before">
              <figcaption>Before</figcaption>
              <DeviceFrame capture={before} />
            </figure>
            <figure data-frame="after">
              <figcaption>After</figcaption>
              <DeviceFrame capture={capture} />
            </figure>
          </div>
        ) : capture ? (
          <DeviceFrame
            key={(annotationFrame ?? capture).screenshot.filename}
            capture={annotationFrame ?? frame ?? capture}
            selecting={marked}
            region={region}
            onRegion={setRegion}
            annotation={annotation}
            onTap={
              inspecting && !stale && !locked
                ? (x, y) =>
                    void act("Inspecting app", async () => {
                      setInspecting(false);
                      await runtime.click(capture.screenshot.filename, x, y);
                      const next = await runtime.capture();
                      if (mounted.current) onCapture(next);
                    })
                : undefined
            }
          />
        ) : (
          <div className="gyro-app-preview-empty">
            <strong>{target.title}</strong>
            <span>
              {pending ||
                (!isSimulator
                  ? "Capture the selected app window."
                  : target.booted
                    ? "Capture the current app or run a scheme."
                    : "Run an Xcode scheme to start this device.")}
            </span>
          </div>
        )}
        {marked && !region && (
          <div className="gyro-preview-device-instruction">
            <span>Drag over the area to annotate.</span>
            <button
              type="button"
              onClick={() =>
                annotationFrame &&
                setRegion({
                  x: 0,
                  y: 0,
                  width: annotationFrame.screenshot.width,
                  height: annotationFrame.screenshot.height,
                })
              }
            >
              Select whole screen
            </button>
          </div>
        )}
      </div>
      <footer className="gyro-preview-device-footer">
        <span role="status">
          {pending ||
            (comparing
              ? "Comparison"
              : marked
                ? "Captured for annotation"
                : frame
                  ? `Auto-refresh · ${frame.screenshot.width} × ${frame.screenshot.height} px`
                  : capture
                    ? `Snapshot · ${capture.screenshot.width} × ${capture.screenshot.height} px`
                    : isSimulator
                      ? "Simulator"
                      : "Mac window")}
        </span>
        {isSimulator && runtime.openDevice && (
          <button
            type="button"
            disabled={locked || marked}
            onClick={() =>
              void act("Opening Device Hub", async () => {
                await runtime.openDevice?.();
              })
            }
          >
            Open in Device Hub
          </button>
        )}
        {isSimulator && capture && runtime.simulatorFrame && !comparing && (
          <button
            type="button"
            aria-pressed={autoRefresh}
            disabled={locked || marked}
            onClick={() => {
              setAutoRefresh((value) => !value);
              setFrame(undefined);
              setError("");
            }}
          >
            Auto-refresh
          </button>
        )}
        {target.booted !== false && (
          <button
            type="button"
            disabled={locked || marked}
            onClick={() => {
              setInspecting(false);
              setComparing(false);
              setFrame(undefined);
              setError("");
              onRefresh();
            }}
          >
            {capture ? "Refresh" : "Capture"}
          </button>
        )}
      </footer>
    </div>
  );
}
