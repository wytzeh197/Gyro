import { Zap } from "lucide-react";
import { clippingBounds } from "./composer-popover-bounds";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

let clientRectsIncludeZoom: boolean | undefined;

/** Older WebKit reports unzoomed rectangles, while pointer clientX stays in viewport pixels. */
function effortViewportRect(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  if (clientRectsIncludeZoom === undefined) {
    const probe = document.createElement("div");
    probe.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:20px;height:20px;zoom:2;visibility:hidden;pointer-events:none";
    document.body.append(probe);
    clientRectsIncludeZoom = probe.getBoundingClientRect().width > 30;
    probe.remove();
  }
  let zoom = 1;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const factor = Number.parseFloat(getComputedStyle(node).zoom);
    if (Number.isFinite(factor) && factor > 0) zoom *= factor;
  }
  const scale = clientRectsIncludeZoom ? 1 : zoom;
  return {
    left: rect.left * scale,
    right: rect.right * scale,
    top: rect.top * scale,
    bottom: rect.bottom * scale,
    width: rect.width * scale,
    height: rect.height * scale,
    zoom,
  };
}

/** Continuous pointer feedback, with native stepped keys and one saved choice on release. */
export function ComposerEffortSelector({
  id,
  labels,
  selectedIndex,
  placement,
  onSelect,
  fastMode,
}: {
  id: string;
  labels: string[];
  selectedIndex: number;
  placement: "up" | "down";
  onSelect: (index: number) => void;
  fastMode?: { enabled: boolean; onToggle: () => void };
}) {
  const normalizedIndex = Math.max(
    0,
    Math.min(selectedIndex, labels.length - 1),
  );
  const [index, setIndex] = useState(normalizedIndex);
  const [dragProgress, setDragProgress] = useState<number>();
  const isAtMaximum =
    labels.length > 1 &&
    index === labels.length - 1 &&
    dragProgress === undefined;
  const [showMaxUsageNotice, setShowMaxUsageNotice] = useState(isAtMaximum);
  useEffect(() => {
    setShowMaxUsageNotice(isAtMaximum);
    if (!isAtMaximum) return;
    const timer = window.setTimeout(() => setShowMaxUsageNotice(false), 2500);
    return () => window.clearTimeout(timer);
  }, [isAtMaximum]);
  const committedIndex = useRef(normalizedIndex);
  const pointer = useRef<{ id: number; offset: number }>();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setIndex(normalizedIndex);
    committedIndex.current = normalizedIndex;
  }, [normalizedIndex, labels.length]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const position = () => {
      panel.style.translate = "";
      const bounds = clippingBounds(panel, effortViewportRect);
      const pad = 12;
      const zoom = effortViewportRect(panel).zoom;
      panel.style.maxWidth = `${Math.max(0, bounds.right - bounds.left - pad * 2) / zoom}px`;
      const rect = effortViewportRect(panel);
      const shift = Math.max(
        bounds.left + pad - rect.left,
        Math.min(0, bounds.right - pad - rect.right),
      );
      panel.style.translate = `${shift / rect.zoom}px 0`;
    };
    position();
    const observer = new ResizeObserver(position);
    for (
      let ancestor = panel.parentElement;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      observer.observe(ancestor);
    }
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [placement]);
  const commit = (next: number) => {
    setIndex(next);
    if (next === committedIndex.current) return;
    committedIndex.current = next;
    onSelect(next);
  };
  const progressAtPointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const rect = effortViewportRect(input);
    const thumbSize = Math.min(rect.height, rect.width);
    const travel = rect.width - thumbSize;
    if (travel <= 0) return 0;
    return Math.max(
      0,
      Math.min(
        1,
        (event.clientX -
          rect.left -
          thumbSize / 2 -
          (pointer.current?.offset ?? 0)) /
          travel,
      ),
    );
  };
  const updatePointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    const progress = progressAtPointer(event);
    setDragProgress(progress);
    setIndex(Math.round(progress * Math.max(0, labels.length - 1)));
    return progress;
  };
  const cancelPointer = () => {
    pointer.current = undefined;
    setDragProgress(undefined);
    setIndex(committedIndex.current);
  };
  return (
    <div
      aria-label="Reasoning effort"
      className="gyro-composer-popover gyro-effort-slider-popover"
      data-max-effort={labels.length > 1 && index === labels.length - 1}
      data-dragging={dragProgress !== undefined}
      data-fast-mode-supported={Boolean(fastMode)}
      data-align="end"
      data-placement={placement}
      id={id}
      ref={panelRef}
      role="dialog"
    >
      <div className="gyro-effort-slider-header">
        {fastMode ? (
          <button
            aria-label="Fast mode"
            aria-pressed={fastMode.enabled}
            className="gyro-effort-fast-button"
            onClick={fastMode.onToggle}
            title={`Fast mode ${fastMode.enabled ? "on" : "off"} · higher usage`}
            type="button"
          >
            <Zap aria-hidden="true" size={15} />
          </button>
        ) : null}
        <div className="gyro-effort-slider-heading">
          <span
            className="gyro-effort-value"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {showMaxUsageNotice && isAtMaximum
              ? "Consumes Usage Fastest"
              : labels[index]}
          </span>
        </div>
      </div>
      <div
        className="gyro-effort-slider"
        style={
          {
            "--effort-progress":
              dragProgress ??
              (labels.length > 1 ? index / (labels.length - 1) : 0),
          } as CSSProperties
        }
      >
        <div aria-hidden="true" className="gyro-effort-slider-track">
          <div className="gyro-effort-slider-fill" />
        </div>
        <div aria-hidden="true" className="gyro-effort-slider-stops">
          {labels.map((label, stop) => (
            <span
              className={stop <= index ? "is-filled" : undefined}
              key={label}
            />
          ))}
        </div>
        <span aria-hidden="true" className="gyro-effort-slider-thumb" />
        <input
          autoFocus
          aria-label="Reasoning effort"
          aria-valuetext={labels[index]}
          disabled={labels.length < 2}
          min={0}
          max={Math.max(0, labels.length - 1)}
          step={1}
          type="range"
          value={index}
          onChange={(event) => {
            if (!pointer.current) setIndex(Number(event.currentTarget.value));
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary || labels.length < 2)
              return;
            event.preventDefault();
            const input = event.currentTarget;
            input.focus();
            const rect = effortViewportRect(input);
            const thumbSize = Math.min(rect.height, rect.width);
            const center =
              rect.left +
              thumbSize / 2 +
              ((rect.width - thumbSize) * index) / (labels.length - 1);
            // Keep the original grab point when taking hold of the thumb.
            // Clicking elsewhere on the track centers the thumb there.
            pointer.current = {
              id: event.pointerId,
              offset:
                Math.abs(event.clientX - center) <= thumbSize / 2
                  ? event.clientX - center
                  : 0,
            };
            input.setPointerCapture(event.pointerId);
            updatePointer(event);
          }}
          onPointerMove={(event) => {
            if (pointer.current?.id === event.pointerId) updatePointer(event);
          }}
          onPointerUp={(event) => {
            if (pointer.current?.id !== event.pointerId) return;
            const next = Math.round(
              progressAtPointer(event) * (labels.length - 1),
            );
            pointer.current = undefined;
            setDragProgress(undefined);
            event.currentTarget.releasePointerCapture(event.pointerId);
            commit(next);
          }}
          onPointerCancel={cancelPointer}
          onLostPointerCapture={() => {
            if (pointer.current) cancelPointer();
          }}
          onKeyUp={(event) => {
            if (!pointer.current) commit(Number(event.currentTarget.value));
          }}
          onBlur={(event) => {
            if (pointer.current) cancelPointer();
            else commit(Number(event.currentTarget.value));
          }}
        />
      </div>
    </div>
  );
}
