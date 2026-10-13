// Page-local input for a private agent webview. Never moves the OS cursor.
// The broker checks policy and screenshot freshness before this runs.
(function createBackgroundPointer(agent, window, document) {
  const pointerId = 2147483000;
  return function backgroundPointer(options) {
    const { action, x, y, toX = x, toY = y } = options;
    if (!["hover", "click", "secondary-click", "drag"].includes(action))
      return { ok: false, error: "unsupported browser pointer action" };
    const points =
      action === "drag"
        ? Array.from({ length: 13 }, (_, step) => [
            x + ((toX - x) * step) / 12,
            y + ((toY - y) * step) / 12,
          ])
        : [[x, y]];
    const check = (px, py) => {
      if (
        !Number.isFinite(px) ||
        !Number.isFinite(py) ||
        px < 0 ||
        py < 0 ||
        px >= window.innerWidth ||
        py >= window.innerHeight
      )
        return "pointer coordinates are outside the browser viewport";
      const target = agent.pointerTarget({ x: px, y: py });
      return !target.ok ||
        target.blocked ||
        (action !== "hover" && target.sensitive)
        ? target.error ||
            target.blockedReason ||
            "this target needs user takeover"
        : undefined;
    };
    for (const [px, py] of points) {
      const error = check(px, py);
      if (error) return { ok: false, error };
    }
    const target = document.elementFromPoint(x, y);
    if (!target || target.closest("[disabled],[inert]"))
      return { ok: false, error: "pointer target is unavailable or disabled" };
    const button = action === "secondary-click" ? 2 : 0;
    const send = (element, type, px, py, buttons = 0) =>
      element.dispatchEvent(
        new (type.startsWith("pointer") || type.endsWith("pointercapture")
          ? window.PointerEvent
          : window.MouseEvent)(type, {
          bubbles: !["pointerenter", "mouseenter"].includes(type),
          cancelable: true,
          view: window,
          clientX: px,
          clientY: py,
          button,
          buttons,
          pointerId,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    const move = (element, px, py, buttons = 0) => {
      send(element, "pointermove", px, py, buttons);
      send(element, "mousemove", px, py, buttons);
    };
    let captured;
    let position = [x, y];
    const prototype = window.Element?.prototype;
    const descriptors = new Map();
    // Synthetic PointerEvents have no native active pointer. Give this one
    // page-local pointer scoped capture semantics, then restore all methods.
    // Other pointer IDs continue to use the browser's original methods.
    const patch = (name, handler) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      descriptors.set(name, descriptor);
      const original = prototype[name];
      Object.defineProperty(prototype, name, {
        configurable: true,
        writable: true,
        value(id) {
          return id === pointerId ? handler(this) : original.call(this, id);
        },
      });
    };
    let draggable;
    let transfer;
    const dragEvent = (element, type, px, py) =>
      element.dispatchEvent(
        new window.DragEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: px,
          clientY: py,
          dataTransfer: transfer,
        }),
      );
    try {
      if (prototype && action !== "hover") {
        patch("setPointerCapture", (element) => {
          if (captured && captured !== element)
            send(captured, "lostpointercapture", ...position);
          captured = element;
          send(element, "gotpointercapture", ...position);
        });
        patch("releasePointerCapture", (element) => {
          if (captured === element) {
            captured = undefined;
            send(element, "lostpointercapture", ...position);
          }
        });
        patch("hasPointerCapture", (element) => captured === element);
      }
      send(target, "pointerover", x, y);
      send(target, "mouseover", x, y);
      send(target, "pointerenter", x, y);
      send(target, "mouseenter", x, y);
      move(target, x, y);
      if (action !== "hover") {
        const buttons = button === 2 ? 2 : 1;
        const pointerDefault = send(target, "pointerdown", x, y, buttons);
        const mouseDefault =
          pointerDefault && send(target, "mousedown", x, y, buttons);
        if (mouseDefault && typeof target.focus === "function")
          target.focus({ preventScroll: true });
        const nativeRange =
          action !== "secondary-click" &&
          mouseDefault &&
          target.tagName === "INPUT" &&
          target.type === "range";
        const initialValue = target.value;
        const rangeAt = (px) => {
          if (!nativeRange) return;
          const rect = target.getBoundingClientRect();
          const thumb = Math.min(rect.height, rect.width);
          const travel = rect.width - thumb;
          const progress =
            travel > 0
              ? Math.max(0, Math.min(1, (px - rect.left - thumb / 2) / travel))
              : 0;
          const minimum = target.min === "" ? 0 : Number(target.min);
          const maximum = target.max === "" ? 100 : Number(target.max);
          const step =
            target.step === "any"
              ? 0
              : Number(target.step) > 0
                ? Number(target.step)
                : 1;
          let value = minimum + progress * (maximum - minimum);
          if (step)
            value = minimum + Math.round((value - minimum) / step) * step;
          value = Math.max(minimum, Math.min(maximum, value));
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          ).set;
          setter.call(target, String(Number(value.toPrecision(12))));
          target.dispatchEvent(new window.Event("input", { bubbles: true }));
        };
        rangeAt(x);
        if (action === "drag") {
          draggable = target.closest('[draggable="true"]');
          if (draggable && window.DataTransfer && window.DragEvent) {
            transfer = new window.DataTransfer();
            transfer.effectAllowed = "all";
            if (!dragEvent(draggable, "dragstart", x, y)) transfer = undefined;
          }
          for (const [px, py] of points.slice(1)) {
            position = [px, py];
            move(captured || target, px, py, buttons);
            rangeAt(px);
            if (transfer) {
              const over = document.elementFromPoint(px, py);
              if (over) dragEvent(over, "dragover", px, py);
            }
          }
          const error = check(toX, toY);
          const release = captured || target;
          send(release, "pointerup", toX, toY);
          send(release, "mouseup", toX, toY);
          if (transfer) {
            const drop = document.elementFromPoint(toX, toY);
            if (!error && drop) dragEvent(drop, "drop", toX, toY);
            dragEvent(draggable, "dragend", toX, toY);
          }
          if (error) return { ok: false, error };
        } else {
          send(captured || target, "pointerup", x, y);
          send(captured || target, "mouseup", x, y);
          send(
            target,
            action === "secondary-click" ? "contextmenu" : "click",
            x,
            y,
          );
        }
        if (nativeRange && target.value !== initialValue)
          target.dispatchEvent(new window.Event("change", { bubbles: true }));
      }
      return {
        ok: true,
        inputMode: "page-events",
        dragMode:
          action === "drag"
            ? transfer
              ? "html-drag-events"
              : "pointer-events"
            : undefined,
        verification:
          "Re-observe the result. Background input cannot provide trusted OS events, native menus, external file drops, or CSS hover state.",
      };
    } catch (error) {
      return {
        ok: false,
        error: "Background pointer action failed: " + String(error),
      };
    } finally {
      try {
        if (captured) send(captured, "lostpointercapture", ...position);
      } finally {
        for (const [name, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(prototype, name, descriptor);
          else delete prototype[name];
        }
      }
    }
  };
});
