import { Zap } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

/** Native stepped range, with local drag feedback and one saved choice on release. */
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
  const [dragging, setDragging] = useState(false);
  const committedIndex = useRef(normalizedIndex);
  const pointerStart = useRef<number>();
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
      const rect = panel.getBoundingClientRect();
      const shift = Math.max(
        12 - rect.left,
        Math.min(0, window.innerWidth - 12 - rect.right),
      );
      panel.style.translate = `${shift}px 0`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel.parentElement!);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [placement]);
  const commit = (next: number) => {
    setIndex(next);
    if (next === committedIndex.current) return;
    committedIndex.current = next;
    onSelect(next);
  };
  return (
    <div
      aria-label="Reasoning effort"
      className="gyro-composer-popover gyro-effort-slider-popover"
      data-max-effort={labels.length > 1 && index === labels.length - 1}
      data-dragging={dragging}
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
          <span className="gyro-effort-value">{labels[index]}</span>
        </div>
      </div>
      <div
        className="gyro-effort-slider"
        style={
          {
            "--effort-progress":
              labels.length > 1 ? index / (labels.length - 1) : 0,
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
          onChange={(event) => setIndex(Number(event.currentTarget.value))}
          onPointerDown={(event) => {
            pointerStart.current = event.clientX;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (
              pointerStart.current !== undefined &&
              Math.abs(event.clientX - pointerStart.current) > 2
            ) {
              setDragging(true);
            }
          }}
          onPointerUp={(event) => {
            pointerStart.current = undefined;
            setDragging(false);
            commit(Number(event.currentTarget.value));
          }}
          onPointerCancel={() => {
            pointerStart.current = undefined;
            setDragging(false);
            setIndex(committedIndex.current);
          }}
          onKeyUp={(event) => commit(Number(event.currentTarget.value))}
          onBlur={(event) => {
            pointerStart.current = undefined;
            setDragging(false);
            commit(Number(event.currentTarget.value));
          }}
        />
      </div>
    </div>
  );
}
