import { ChevronRight, RotateCcw, Zap } from "lucide-react";
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
  modelLabel,
  labels,
  selectedIndex,
  defaultIndex,
  placement,
  onSelect,
  onModels,
  onSettings,
}: {
  id: string;
  modelLabel: string;
  labels: string[];
  selectedIndex: number;
  defaultIndex: number;
  placement: "up" | "down";
  onSelect: (index: number) => void;
  onModels: () => void;
  onSettings: () => void;
}) {
  const [index, setIndex] = useState(selectedIndex);
  const committedIndex = useRef(selectedIndex);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setIndex(selectedIndex);
    committedIndex.current = selectedIndex;
  }, [selectedIndex]);
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
      aria-label="Model and effort"
      className="gyro-composer-popover gyro-effort-slider-popover"
      data-max-effort={labels.length > 1 && index === labels.length - 1}
      data-align="end"
      data-placement={placement}
      id={id}
      ref={panelRef}
      role="dialog"
    >
      <div className="gyro-effort-slider-header">
        <button
          aria-label="Advanced model settings"
          title="Advanced model settings"
          className="gyro-effort-icon-button"
          onClick={onSettings}
          type="button"
        >
          <Zap size={17} />
        </button>
        <div className="gyro-effort-slider-heading">
          <button
            className="gyro-effort-value-button"
            aria-label={`Select model: ${modelLabel}`}
            onClick={onModels}
            type="button"
          >
            {labels[index]}
            <ChevronRight size={16} />
          </button>
          <button
            className="gyro-effort-model-button"
            onClick={onModels}
            title={`Select model: ${modelLabel}`}
            type="button"
          >
            {modelLabel}
          </button>
        </div>
        <button
          aria-label={`Reset effort to ${labels[defaultIndex]}`}
          title={`Reset effort to ${labels[defaultIndex]}`}
          className="gyro-effort-icon-button"
          onClick={() => commit(defaultIndex)}
          type="button"
        >
          <RotateCcw size={17} />
        </button>
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
        <input
          aria-label="Reasoning effort"
          aria-valuetext={labels[index]}
          disabled={labels.length < 2}
          min={0}
          max={labels.length - 1}
          step={1}
          type="range"
          value={index}
          onChange={(event) => setIndex(Number(event.currentTarget.value))}
          onPointerUp={(event) => commit(Number(event.currentTarget.value))}
          onPointerCancel={() => setIndex(committedIndex.current)}
          onKeyUp={(event) => commit(Number(event.currentTarget.value))}
          onBlur={(event) => commit(Number(event.currentTarget.value))}
        />
      </div>
    </div>
  );
}
