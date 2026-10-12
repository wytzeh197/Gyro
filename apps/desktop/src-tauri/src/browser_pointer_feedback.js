// Inert, page-local feedback shared by ref-based tools and native mouse input.
// Movement is best effort and synchronous to request; native actions never wait for it.
(function createBrowserPointerFeedback(window, document) {
  let cursor = null;
  let targetBox = null;
  let cursorTimer = 0;
  let targetTimer = 0;
  let frame = 0;
  let motionId = 0;
  let revision = 0;
  let position = null;
  let destination = null;
  let pulse = null;
  let pendingPulse = null;
  let hidden = false;
  let labelWidth = 0;
  const motionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const stopMotion = () => {
    motionId += 1;
    window.cancelAnimationFrame?.(frame);
    frame = 0;
    destination = null;
  };
  const stopPulse = () => {
    pulse?.cancel();
    pulse = null;
    pendingPulse = null;
  };
  const paint = (x, y) => {
    position = { x, y };
    cursor.style.transform = `translate3d(${x - 2}px,${y - 2}px,0)`;
    const labelX =
      x + 24 + labelWidth > window.innerWidth - 8
        ? x - labelWidth - 8
        : x + 24;
    cursor.lastChild.style.left = `${Math.max(8, Math.min(window.innerWidth - labelWidth - 8, labelX)) - x + 2}px`;
    cursor.lastChild.style.top = y > window.innerHeight - 36 ? "-24px" : "18px";
  };
  const pulseAtArrival = () => {
    if (
      !pendingPulse || !cursor || pendingPulse.revision !== revision ||
      position.x !== pendingPulse.x || position.y !== pendingPulse.y
    ) return;
    pendingPulse = null;
    if (motionPreference?.matches || !cursor.firstChild.animate) return;
    try {
      pulse = cursor.firstChild.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(.8)" },
          { transform: "scale(1)" },
        ],
        { duration: 260, easing: "ease-out" },
      );
    } catch {
      // Arrival feedback must not interfere with input or later movement.
    }
  };
  const preferenceChanged = () => {
    if (!motionPreference.matches) return;
    const target = destination;
    stopMotion();
    stopPulse();
    if (cursor && target) paint(target.x, target.y);
  };
  const move = (x, y, immediate) => {
    if (immediate || !position || !window.requestAnimationFrame) {
      stopMotion();
      paint(x, y);
      pulseAtArrival();
      return;
    }
    // Completion at the same target preserves the trip and its remaining time.
    if (destination?.x === x && destination?.y === y) return;
    stopMotion();
    const from = position;
    const distance = Math.hypot(x - from.x, y - from.y);
    if (distance < 1) {
      paint(x, y);
      pulseAtArrival();
      return;
    }
    destination = { x, y };
    const id = motionId;
    const start = window.performance.now();
    const duration = Math.min(140, Math.max(70, 60 + distance * 0.12));
    const tick = (now) => {
      if (id !== motionId || !cursor) return;
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - (1 - progress) ** 3;
      if (progress === 1) paint(x, y);
      else paint(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
      if (progress < 1) frame = window.requestAnimationFrame(tick);
      else {
        frame = 0;
        destination = null;
        pulseAtArrival();
      }
    };
    frame = window.requestAnimationFrame(tick);
  };
  const clear = () => {
    revision += 1;
    stopMotion();
    stopPulse();
    window.removeEventListener?.("pagehide", clear);
    motionPreference?.removeEventListener?.("change", preferenceChanged);
    window.clearTimeout(cursorTimer);
    window.clearTimeout(targetTimer);
    cursor?.remove();
    targetBox?.remove();
    cursor = targetBox = null;
    position = null;
    cursorTimer = targetTimer = 0;
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
      const reduced = motionPreference?.matches;
      const currentRevision = ++revision;
      stopPulse();
      window.clearTimeout(cursorTimer);
      window.clearTimeout(targetTimer);
      targetBox?.remove();
      targetBox = null;
      if (!cursor) {
        cursor = document.createElement("div");
        cursor.setAttribute("aria-hidden", "true");
        cursor.setAttribute("data-gyro-browser-pointer", "");
        cursor.style.cssText =
          "position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;width:24px;height:28px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.4))";
        cursor.style.transition = "none";
        cursor.style.visibility = hidden ? "hidden" : "visible";
        window.addEventListener?.("pagehide", clear);
        motionPreference?.addEventListener?.("change", preferenceChanged);
        // Reuse Gyro's existing model-pointer vector.
        const arrow = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        arrow.setAttribute("width", "24");
        arrow.setAttribute("height", "28");
        arrow.setAttribute("viewBox", "0 0 24 28");
        arrow.style.transformOrigin = "2px 2px";
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
      const label = cursor.lastChild;
      label.textContent = String(options.actor || "Gyro").slice(0, 32);
      label.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
      labelWidth = label.offsetWidth;
      const completedAction = options.phase !== "move" && options.action !== "hover";
      if (completedAction) {
        targetBox = document.createElement("div");
        targetBox.setAttribute("aria-hidden", "true");
        targetBox.setAttribute("data-gyro-browser-target", "");
        targetBox.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;box-sizing:border-box;border:2px solid #0874df;border-radius:6px;box-shadow:0 0 0 4px rgba(8,116,223,.18)`;
        targetBox.style.visibility = hidden ? "hidden" : "visible";
        document.documentElement.appendChild(targetBox);
        // Native input is already complete. Highlight now and pulse at arrival.
        pendingPulse = { x: px, y: py, revision: currentRevision };
        const box = targetBox;
        targetTimer = window.setTimeout(() => {
          if (targetBox !== box) return;
          targetBox?.remove();
          targetBox = null;
        }, 700);
      }
      // Visual travel never delays native input or changes its real coordinates.
      // The SVG's tip is (2,2); paint() aligns it with the page coordinate.
      move(px, py, reduced);
      if (position) paint(position.x, position.y);
      // Match the browser presence strip's linger, rather than disappearing
      // before the person watching can locate the pointer.
      cursorTimer = window.setTimeout(() => {
        if (revision === currentRevision) clear();
      }, 6000);
    } catch {
      clear();
      // Feedback must never turn a successful browser action into a retry.
    }
  };
  const setHidden = (value) => {
    hidden = Boolean(value);
    if (cursor) cursor.style.visibility = hidden ? "hidden" : "visible";
    if (targetBox) targetBox.style.visibility = hidden ? "hidden" : "visible";
  };
  return { show, clear, setHidden };
});
