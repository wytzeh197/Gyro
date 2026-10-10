// Inert, page-local feedback shared by ref-based tools and native mouse input.
// The cursor tip stays at the real target; only its label flips at page edges.
(function createBrowserPointerFeedback(window, document) {
  let cursor = null;
  let targetBox = null;
  let cursorTimer = 0;
  let targetTimer = 0;
  const clear = () => {
    window.clearTimeout(cursorTimer);
    window.clearTimeout(targetTimer);
    cursor?.remove();
    targetBox?.remove();
    cursor = targetBox = null;
  };
  const show = (el, options = {}) => {
    try {
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const dragging = options.action === "drag" && options.phase !== "move";
      const x = dragging
        ? options.toX
        : (options.x ?? rect.left + rect.width / 2);
      const y = dragging
        ? options.toY
        : (options.y ?? rect.top + rect.height / 2);
      if (![x, y].every(Number.isFinite)) return;
      const px = Math.max(0, Math.min(window.innerWidth - 1, x));
      const py = Math.max(0, Math.min(window.innerHeight - 1, y));
      const reduced = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      window.clearTimeout(cursorTimer);
      window.clearTimeout(targetTimer);
      targetBox?.remove();
      targetBox = null;
      if (!cursor) {
        cursor = document.createElement("div");
        cursor.setAttribute("aria-hidden", "true");
        cursor.setAttribute("data-gyro-browser-pointer", "");
        cursor.style.cssText =
          "position:fixed;pointer-events:none;z-index:2147483647;width:24px;height:28px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.4))";
        // Reuse Gyro's existing model-pointer vector.
        const arrow = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        arrow.setAttribute("width", "24");
        arrow.setAttribute("height", "28");
        arrow.setAttribute("viewBox", "0 0 24 28");
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute("d", "M2 2 L21 16 L13 17 L9 25 Z");
        path.setAttribute("fill", "rgb(8, 116, 223)");
        path.setAttribute("stroke", "white");
        path.setAttribute("stroke-width", "2");
        path.setAttribute("stroke-linejoin", "round");
        arrow.appendChild(path);
        const label = document.createElement("span");
        label.style.cssText =
          "position:absolute;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;font:600 11px system-ui;color:#fff;background:#0874df;border-radius:4px;padding:3px 6px";
        cursor.append(arrow, label);
        document.documentElement.appendChild(cursor);
      }
      cursor.style.transition = reduced
        ? "none"
        : "left 120ms ease-out,top 120ms ease-out";
      // The SVG's tip is (2,2); align that tip with the actual page coordinate.
      cursor.style.left = `${px - 2}px`;
      cursor.style.top = `${py - 2}px`;
      const label = cursor.lastChild;
      label.textContent = String(options.actor || "Gyro").slice(0, 32);
      label.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
      const labelWidth = label.offsetWidth;
      const labelX =
        px + 24 + labelWidth > window.innerWidth - 8
          ? px - labelWidth - 8
          : px + 24;
      label.style.left = `${Math.max(8, Math.min(window.innerWidth - labelWidth - 8, labelX)) - px + 2}px`;
      label.style.top = py > window.innerHeight - 36 ? "-24px" : "18px";

      if (options.phase !== "move" && options.action !== "hover") {
        targetBox = document.createElement("div");
        targetBox.setAttribute("aria-hidden", "true");
        targetBox.setAttribute("data-gyro-browser-target", "");
        targetBox.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;box-sizing:border-box;border:2px solid #0874df;border-radius:6px;box-shadow:0 0 0 4px rgba(8,116,223,.18)`;
        document.documentElement.appendChild(targetBox);
        // A short press pulse makes a click distinguishable from a move.
        if (!reduced && cursor.firstChild.animate) {
          cursor.firstChild.animate(
            [
              { transform: "scale(1)" },
              { transform: "scale(.8)" },
              { transform: "scale(1)" },
            ],
            { duration: 260, easing: "ease-out" },
          );
        }
        targetTimer = window.setTimeout(() => {
          targetBox?.remove();
          targetBox = null;
        }, 700);
      }
      // Match the browser presence strip's linger, rather than disappearing
      // before the person watching can locate the pointer.
      cursorTimer = window.setTimeout(clear, 6000);
    } catch {
      // Feedback must never turn a successful browser action into a retry.
    }
  };
  const setHidden = (hidden) => {
    if (cursor) cursor.style.visibility = hidden ? "hidden" : "visible";
    if (targetBox) targetBox.style.visibility = hidden ? "hidden" : "visible";
  };
  return { show, clear, setHidden };
});
