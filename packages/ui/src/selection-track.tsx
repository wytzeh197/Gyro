import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Selection moves; initial layout, wrapping, and resizing always snap. */
export function SelectionTrack({
  children,
  className,
  label,
  value,
}: {
  children: ReactNode;
  className: string;
  label: string;
  value: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<(animate: boolean) => void>(() => {});
  const previousValue = useRef(value);

  useLayoutEffect(() => {
    const root = rootRef.current!;
    const indicator = root.querySelector<HTMLElement>(
      ".gyro-selection-indicator",
    )!;
    let geometry = "";
    const measure = (animate: boolean) => {
      const selected = root.querySelector<HTMLElement>(
        'button[aria-pressed="true"]',
      );
      if (!selected) {
        root.removeAttribute("data-selection-ready");
        geometry = "";
        return;
      }
      // offset* rounds to whole pixels, which shifts the highlight at scaled
      // sizes. Absolute children originate inside the track's border box.
      const bounds = selected.getBoundingClientRect();
      const trackBounds = root.getBoundingClientRect();
      const style = getComputedStyle(root);
      const next = [
        bounds.left -
          trackBounds.left -
          parseFloat(style.borderLeftWidth) +
          root.scrollLeft,
        bounds.top -
          trackBounds.top -
          parseFloat(style.borderTopWidth) +
          root.scrollTop,
        bounds.width,
        bounds.height,
      ];
      const signature = next.join(",");
      if (signature === geometry) return;
      indicator.style.transition = animate && geometry ? "" : "none";
      indicator.style.width = `${next[2]}px`;
      indicator.style.height = `${next[3]}px`;
      indicator.style.transform = `translate(${next[0]}px, ${next[1]}px)`;
      root.dataset.selectionReady = "true";
      geometry = signature;
    };
    measureRef.current = measure;
    measure(false);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(root);
    root
      .querySelectorAll("button")
      .forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    measureRef.current(previousValue.current !== value);
    previousValue.current = value;
  }, [value]);

  return (
    <div
      aria-label={label}
      className={`${className} gyro-selection-track`}
      ref={rootRef}
      role="group"
    >
      <span aria-hidden="true" className="gyro-selection-indicator" />
      {children}
    </div>
  );
}
