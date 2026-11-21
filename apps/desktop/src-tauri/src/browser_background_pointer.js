// Page-local model input, including movement in a visible browser.
// The broker checks policy and screenshot freshness before this runs.
(function createBackgroundPointer(agent, window, document) {
  const pointerId = 2147483000;
  let hovered;
  const send = (
    element,
    type,
    x,
    y,
    button = 0,
    buttons = 0,
    relatedTarget = null,
  ) =>
    element.dispatchEvent(
      new (type.startsWith("pointer") || type.endsWith("pointercapture")
        ? window.PointerEvent
        : window.MouseEvent)(type, {
        bubbles: !/enter$|leave$/.test(type),
        cancelable: true,
        composed: !/enter$|leave$/.test(type),
        view: window,
        clientX: x,
        clientY: y,
        button,
        buttons,
        pointerId,
        pointerType: "mouse",
        isPrimary: true,
        relatedTarget,
      }),
    );
  const hoverAt = (x, y, target) => {
    const previous = hovered;
    hovered = target;
    if (previous !== target) {
      if (previous?.isConnected) {
        for (const type of [
          "pointerout",
          "mouseout",
          "pointerleave",
          "mouseleave",
        ])
          send(previous, type, x, y, -1, 0, target);
      }
      if (target) {
        for (const type of [
          "pointerover",
          "mouseover",
          "pointerenter",
          "mouseenter",
        ])
          send(target, type, x, y, -1, 0, previous);
      }
    }
    if (target) {
      send(target, "pointermove", x, y, -1);
      send(target, "mousemove", x, y);
    }
  };
  return function backgroundPointer(options) {
    const { action, x, y, toX = x, toY = y, expected } = options;
    if (action === "move") {
      const observed = agent.pointerTarget({ x, y, movement: true });
      const target =
        observed.ok && !observed.blocked
          ? document.elementFromPoint(x, y)
          : null;
      hoverAt(x, y, target);
      return { ok: true };
    }
    if (!["hover", "click", "secondary-click", "drag"].includes(action))
      return { ok: false, error: "unsupported browser pointer action" };
    const points =
      action === "drag"
        ? Array.from({ length: 13 }, (_, step) => [
            x + ((toX - x) * step) / 12,
            y + ((toY - y) * step) / 12,
          ])
        : [[x, y]];
    const check = (px, py, token) => {
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
      if (!target.ok ||
        target.blocked ||
        (action !== "hover" && (target.sensitive || target.disabled))) {
        return target.error ||
          (target.disabled ? "this pointer target is disabled" : target.blocked && target.blockedReason) ||
          "this target needs user takeover";
      }
      if (expected && (target.url !== expected.url ||
          !Object.keys(target.viewport).every(key => target.viewport[key] === expected.viewport[key]))) {
        return "browser page or viewport changed; take a new screenshot";
      }
      if (token && token !== target.targetToken) {
        return "browser target changed before the pointer press; take a new screenshot";
      }
    };
    const checkEndpoints = () =>
      check(x, y, expected?.source) ||
      (action === "drag" && check(toX, toY, expected?.destination));
    const endpointError = checkEndpoints();
    if (endpointError) return { ok: false, error: endpointError };
    for (const [px, py] of points.slice(1, -1)) {
      const error = check(px, py);
      if (error) return { ok: false, error };
    }
    const target = document.elementFromPoint(x, y);
    if (!target) return { ok: false, error: "pointer target is unavailable" };
    const button = action === "secondary-click" ? 2 : 0;
    const sendButton = (element, type, px, py, buttons = 0) =>
      send(element, type, px, py, button, buttons);
    const move = (element, px, py, buttons = 0) => {
      sendButton(element, "pointermove", px, py, buttons);
      sendButton(element, "mousemove", px, py, buttons);
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
            sendButton(captured, "lostpointercapture", ...position);
          captured = element;
          sendButton(element, "gotpointercapture", ...position);
        });
        patch("releasePointerCapture", (element) => {
          if (captured === element) {
            captured = undefined;
            sendButton(element, "lostpointercapture", ...position);
          }
        });
        patch("hasPointerCapture", (element) => captured === element);
      }
      hoverAt(x, y, target);
      if (action !== "hover") {
        const error = checkEndpoints();
        if (error || !target.isConnected || target !== document.elementFromPoint(x, y)) {
          return { ok: false, error: error || "browser target changed before the pointer press; take a new screenshot" };
        }
        const buttons = button === 2 ? 2 : 1;
        const pointerDefault = sendButton(target, "pointerdown", x, y, buttons);
        const mouseDefault =
          pointerDefault && sendButton(target, "mousedown", x, y, buttons);
        // Background input must leave keyboard ownership with the user.
        if (
          mouseDefault &&
          document.hasFocus() &&
          typeof target.focus === "function"
        )
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
          const error = check(toX, toY, expected?.destination);
          const release = captured || target;
          sendButton(release, "pointerup", toX, toY);
          sendButton(release, "mouseup", toX, toY);
          if (transfer) {
            const drop = document.elementFromPoint(toX, toY);
            if (!error && drop) dragEvent(drop, "drop", toX, toY);
            dragEvent(draggable, "dragend", toX, toY);
          }
          if (error) return { ok: false, error };
        } else {
          sendButton(captured || target, "pointerup", x, y);
          sendButton(captured || target, "mouseup", x, y);
          sendButton(
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
        if (captured) sendButton(captured, "lostpointercapture", ...position);
      } finally {
        for (const [name, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(prototype, name, descriptor);
          else delete prototype[name];
        }
      }
    }
  };
});
